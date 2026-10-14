import re
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from services.ingestion.app import main, routes_coverage

SUPABASE = Path(__file__).resolve().parents[3] / "supabase"
SCHEMA = (SUPABASE / "schema.sql").read_text(encoding="utf-8").replace("\r\n", "\n")
COVERAGE_SQL = (SUPABASE / "migrations" / "0028_indicator_coverage.sql").read_text(encoding="utf-8").replace("\r\n", "\n")


def response(payload, status_code=200):
    fake = Mock()
    fake.status_code = status_code
    fake.is_success = 200 <= status_code < 300
    fake.json.return_value = payload
    return fake


@patch.dict("os.environ", {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"})
class CollectionCoverageTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def test_lists_one_entry_per_indicator_with_the_covered_period(self):
        rows = [
            {"indicator_code": "eco01_pib_municipal_per_capita", "municipalities": 5570, "value_count": 11140, "first_reference_period": "2022-01-01", "last_reference_period": "2023-01-01"},
            {"indicator_code": "pes01_taxa_de_alfabetizacao", "municipalities": 1, "value_count": 1, "first_reference_period": "2022-01-01", "last_reference_period": "2022-01-01"},
        ]
        with patch.object(routes_coverage.httpx, "get", return_value=response(rows)) as fake_get:
            body = self.client.get("/collection-coverage").json()
        self.assertEqual(body[0], {"indicator_code": "eco01_pib_municipal_per_capita", "municipalities": 5570, "value_count": 11140, "first_period": "2022-01-01", "last_period": "2023-01-01"})
        self.assertEqual(len(body), 2)
        self.assertEqual(fake_get.call_args.args[0], "https://example.supabase.co/rest/v1/indicator_coverage")
        self.assertEqual(fake_get.call_args.kwargs["params"]["order"], "indicator_code")

    def test_an_empty_view_is_an_empty_list(self):
        with patch.object(routes_coverage.httpx, "get", return_value=response([])):
            self.assertEqual(self.client.get("/collection-coverage").json(), [])

    def test_missing_view_points_to_the_migration(self):
        with patch.object(routes_coverage.httpx, "get", return_value=response({"code": "PGRST205"}, 404)):
            result = self.client.get("/collection-coverage")
        self.assertEqual(result.status_code, 503)
        self.assertIn("0028_indicator_coverage.sql", result.json()["detail"])

    def test_database_error_is_a_502(self):
        with patch.object(routes_coverage.httpx, "get", return_value=response({"message": "boom"}, 500)):
            result = self.client.get("/collection-coverage")
        self.assertEqual(result.status_code, 502)
        self.assertIn("boom", result.json()["detail"])


class IndicatorCoverageViewTests(unittest.TestCase):

    def test_view_reads_columns_that_core_dashboard_values_exposes(self):
        latest_definition = re.findall(r"create or replace view core\.dashboard_values as\nselect (.*?)\nfrom core\.published_values", SCHEMA, flags=re.DOTALL)[-1]
        exposed = set(re.findall(r"(?:published_values\.|\bas )(\w+)", latest_definition))
        used = re.findall(r"dashboard_values\.(\w+)", COVERAGE_SQL)
        self.assertEqual(set(used), {"indicator_code", "dimensions", "reference_period"})
        for column in used:
            self.assertIn(column, exposed, column)

    def test_route_columns_match_the_view_aliases(self):
        aliases = {"indicator_code"} | set(re.findall(r" as (\w+)", COVERAGE_SQL))
        for column in routes_coverage.coverage_fields.split(","):
            self.assertIn(column, aliases, column)

    def test_view_counts_distinct_municipalities_per_indicator_and_is_readable_by_the_service_role(self):
        self.assertIn("create or replace view public.indicator_coverage as", COVERAGE_SQL)
        self.assertIn("count(distinct dashboard_values.dimensions ->> 'municipality_ibge_code')", COVERAGE_SQL)
        self.assertIn("from core.dashboard_values dashboard_values", COVERAGE_SQL)
        self.assertIn("group by dashboard_values.indicator_code;", COVERAGE_SQL)
        self.assertIn("grant select on public.indicator_coverage to service_role;", COVERAGE_SQL)

    def test_schema_sql_carries_the_migration_verbatim_once(self):
        self.assertEqual(SCHEMA.count(COVERAGE_SQL.strip()), 1)
        self.assertTrue(SCHEMA.strip().endswith(COVERAGE_SQL.strip()))


if __name__ == "__main__":
    unittest.main()
