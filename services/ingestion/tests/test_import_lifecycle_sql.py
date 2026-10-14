import re
import unittest
from pathlib import Path

from services.ingestion.app import routes_import_lifecycle

SUPABASE = Path(__file__).resolve().parents[3] / "supabase"


def read_sql(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


SCHEMA = read_sql(SUPABASE / "schema.sql")
LIFECYCLE_SQL = read_sql(SUPABASE / "migrations" / "0027_import_lifecycle.sql")
BATCH_APPROVAL_SQL = read_sql(SUPABASE / "migrations" / "0019_batch_municipal_approval.sql")


def schema_tables() -> dict[str, dict]:
    tables: dict[str, dict] = {}
    for name, body in re.findall(r"create table (?:if not exists )?(\w+\.\w+) \(\n(.*?)\n\);", SCHEMA, flags=re.DOTALL):
        columns = {column for column in re.findall(r"^  ([a-z_]+) ", body, flags=re.MULTILINE) if column not in {"primary", "unique", "check", "constraint", "foreign"}}
        tables[name] = {"columns": columns, "references_imports": "references public.imports(id)" in body}
    for name, statement in re.findall(r"alter table (\w+\.\w+)\s+(add column[^;]*);", SCHEMA):
        tables.setdefault(name, {"columns": set(), "references_imports": False})["columns"].update(re.findall(r"add column (?:if not exists )?([a-z_]+)", statement))
    for old_name, new_schema in re.findall(r"alter table (\w+\.\w+) set schema (\w+);", SCHEMA):
        moved_name = f"{new_schema}.{old_name.split('.')[1]}"
        moved = tables.pop(old_name)
        merged = tables.setdefault(moved_name, {"columns": set(), "references_imports": False})
        merged["columns"] |= moved["columns"]
        merged["references_imports"] = merged["references_imports"] or moved["references_imports"]
    return tables


TABLES = schema_tables()
DELETE_ORDER = re.findall(r"delete from (\w+\.\w+)", LIFECYCLE_SQL)
ENUM_STATUSES = set(re.findall(r"'(\w+)'", re.search(r"create type public\.import_status as enum \(([^)]*)\)", SCHEMA).group(1)))


class DeleteImportCascadeTests(unittest.TestCase):
    def test_every_table_the_functions_touch_exists_in_the_schema(self):
        touched = set(DELETE_ORDER) | set(re.findall(r"update (\w+\.\w+)", LIFECYCLE_SQL)) | set(re.findall(r"from (\w+\.\w+)", LIFECYCLE_SQL))
        self.assertTrue(touched >= {"core.published_values", "municipal.observations", "public.imports"})
        for table in touched:
            self.assertIn(table, TABLES, f"{table} nao existe no schema.sql")

    def test_deletes_follow_the_foreign_key_order(self):
        self.assertEqual(DELETE_ORDER, ["core.published_values", "municipal.observations", "public.validation_issues", "public.treatment_proposals", "public.import_rows", "public.import_sheets", "public.imports", "public.sources"])

    def test_every_table_that_references_imports_is_deleted_before_the_import(self):
        referencing = {name for name, table in TABLES.items() if table["references_imports"]}
        self.assertEqual(referencing, {"core.published_values", "municipal.observations", "public.validation_issues", "public.treatment_proposals", "public.import_rows", "public.import_sheets"}, "uma tabela nova aponta para public.imports: inclua-a em delete_import_cascade")
        import_position = DELETE_ORDER.index("public.imports")
        for table in referencing:
            self.assertLess(DELETE_ORDER.index(table), import_position, table)

    def test_restrict_foreign_keys_are_the_ones_that_force_the_explicit_deletes(self):
        for table in ("core.published_values", "municipal.observations"):
            self.assertRegex(SCHEMA, rf"create table {re.escape(table.replace('municipal.', 'public.'))} \([^;]*?references public\.imports\(id\) on delete restrict")

    def test_the_source_is_removed_only_after_the_import_and_only_when_unused(self):
        source_delete = LIFECYCLE_SQL.split("delete from public.sources", 1)[1].split(";", 1)[0]
        self.assertIn("not exists (select 1 from public.imports", source_delete)
        self.assertGreater(LIFECYCLE_SQL.index("delete from public.sources"), LIFECYCLE_SQL.index("delete from public.imports"))

    def test_staged_rows_are_deleted_in_batches_of_5000(self):
        loop_body = LIFECYCLE_SQL.split("  loop\n", 1)[1].split("  end loop;", 1)[0]
        self.assertIn("delete from public.import_rows", loop_body)
        self.assertIn("limit 5000", loop_body)
        self.assertIn("exit when", loop_body)
        self.assertIn("id", TABLES["public.import_rows"]["columns"])

    def test_columns_used_exist(self):
        for table in ("core.published_values", "municipal.observations"):
            self.assertTrue({"import_id", "superseded_at"} <= TABLES[table]["columns"], table)
        for table in ("public.validation_issues", "public.treatment_proposals", "public.import_rows", "public.import_sheets"):
            self.assertIn("import_id", TABLES[table]["columns"], table)
        self.assertTrue({"id", "status", "approved_at", "source_id"} <= TABLES["public.imports"]["columns"])
        self.assertIn("id", TABLES["public.sources"]["columns"])
        self.assertIn("import_id", TABLES["core.published_values"]["columns"])
        self.assertIn("create index if not exists published_values_import_idx on core.published_values (import_id);", LIFECYCLE_SQL)

    def test_the_statuses_the_functions_use_are_enum_values(self):
        self.assertTrue({"approved", "needs_review"} <= ENUM_STATUSES)
        self.assertIn("'needs_review'::public.import_status", LIFECYCLE_SQL)


class FunctionHardeningTests(unittest.TestCase):
    SIGNATURES = ("public.unapprove_import(uuid)", "public.delete_import_cascade(uuid)")

    def test_functions_follow_the_security_definer_pattern_of_migration_0019(self):
        self.assertIn("security definer\nset search_path = public, core, municipal", BATCH_APPROVAL_SQL)
        for signature in self.SIGNATURES:
            name = signature.split("(")[0]
            definition = LIFECYCLE_SQL.split(f"create or replace function {name}(", 1)[1].split("as $$", 1)[0]
            self.assertIn("returns jsonb", definition, name)
            self.assertIn("language plpgsql", definition, name)
            self.assertIn("security definer", definition, name)
            self.assertIn("set search_path = public, core, municipal", definition, name)
            self.assertIn(f"revoke all on function {signature} from public, anon, authenticated;", LIFECYCLE_SQL)
            self.assertIn(f"grant execute on function {signature} to service_role;", LIFECYCLE_SQL)
            self.assertIn(f"alter function {signature} set statement_timeout = '600s';", LIFECYCLE_SQL)

    def test_each_function_body_is_balanced(self):
        for name in ("unapprove_import", "delete_import_cascade"):
            body = LIFECYCLE_SQL.split(f"create or replace function public.{name}(", 1)[1].split("$$;", 1)[0]
            self.assertEqual(body.count("begin\n"), 1, name)
            self.assertEqual(len(re.findall(r"^end;$", body, flags=re.MULTILINE)), 1, name)
            self.assertEqual(len(re.findall(r"^\s*if .* then$", body, flags=re.MULTILINE)), len(re.findall(r"^\s*end if;$", body, flags=re.MULTILINE)), name)
            self.assertEqual(len(re.findall(r"^\s*loop$", body, flags=re.MULTILINE)), len(re.findall(r"^\s*end loop;$", body, flags=re.MULTILINE)), name)

    def test_unapprove_supersedes_values_and_observations_before_changing_the_status(self):
        body = LIFECYCLE_SQL.split("create or replace function public.unapprove_import(", 1)[1].split("$$;", 1)[0]
        self.assertLess(body.index("update core.published_values"), body.index("update public.imports"))
        self.assertLess(body.index("update municipal.observations"), body.index("update public.imports"))
        self.assertIn("approved_at = null", body)
        self.assertEqual(body.count("superseded_at = now()"), 2)
        self.assertNotIn("delete from", body)

    def test_the_python_routes_call_the_functions_with_their_real_parameter_name(self):
        source = Path(routes_import_lifecycle.__file__).read_text(encoding="utf-8")
        for function_name in ("unapprove_import", "delete_import_cascade"):
            self.assertIn(f"/rest/v1/rpc/{function_name}", source)
            self.assertIn(f"create or replace function public.{function_name}(selected_import_id uuid)", LIFECYCLE_SQL)
        self.assertIn('"selected_import_id": import_id', source)


class SchemaIsConsolidatedTests(unittest.TestCase):
    def test_schema_sql_carries_the_migration_verbatim(self):
        self.assertIn(LIFECYCLE_SQL.strip(), SCHEMA)

    def test_the_statements_run_once(self):
        self.assertEqual(SCHEMA.count("create or replace function public.unapprove_import("), 1)
        self.assertEqual(SCHEMA.count("create or replace function public.delete_import_cascade("), 1)


if __name__ == "__main__":
    unittest.main()