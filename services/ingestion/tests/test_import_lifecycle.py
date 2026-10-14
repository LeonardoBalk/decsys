import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from services.ingestion.app import main, routes_import_lifecycle

IMPORT_ID = "6f0c1d9e-2b7a-4c55-9a3e-0d4f8e1b7c21"
STORAGE_PATH = f"imports/{IMPORT_ID}/original/pib 2021.xlsx"


class FakeResponse:
    def __init__(self, payload=None, status_code=200, headers=None):
        self._payload = payload
        self.status_code = status_code
        self.headers = headers or {}
        self.is_success = 200 <= status_code < 300

    def json(self):
        return self._payload


def import_row(status="needs_review", storage_path=STORAGE_PATH):
    return {"id": IMPORT_ID, "title": "PIB 2021", "status": status, "storage_path": storage_path, "total_rows": 5570}


@patch.dict("os.environ", {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"})
class ImportLifecycleRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.calls = []
        self.import_records = [import_row()]
        self.rpc_response = FakeResponse({})
        self.storage_response = FakeResponse([])
        self.counts = {"dashboard_values": 4200, "import_rows": 5570, "import_sheets": 2, "validation_issues": 17}

    def fake_get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        table = url.rsplit("/", 1)[1]
        if table == "imports":
            return FakeResponse(self.import_records)
        if self.counts[table] == 0:
            return FakeResponse([], headers={"content-range": "*/0"})
        return FakeResponse([{"id": 1}], headers={"content-range": f"0-0/{self.counts[table]}"})

    def fake_post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self.rpc_response

    def fake_patch(self, url, **kwargs):
        self.calls.append(("PATCH", url, kwargs))
        return FakeResponse(None, 204)

    def fake_delete(self, url, **kwargs):
        self.calls.append(("DELETE", url, kwargs))
        return self.storage_response

    def request(self, method, path, **kwargs):
        with patch.object(routes_import_lifecycle.httpx, "get", side_effect=self.fake_get), patch.object(routes_import_lifecycle.httpx, "post", side_effect=self.fake_post), patch.object(routes_import_lifecycle.httpx, "patch", side_effect=self.fake_patch), patch.object(routes_import_lifecycle.httpx, "delete", side_effect=self.fake_delete):
            return self.client.request(method, path, **kwargs)

    def calls_to(self, method):
        return [call for call in self.calls if call[0] == method]


    def test_impact_counts_published_values_rows_sheets_and_issues(self):
        body = self.request("GET", f"/imports/{IMPORT_ID}/impact").json()
        self.assertEqual(body, {"import_id": IMPORT_ID, "title": "PIB 2021", "status": "needs_review", "has_file": True, "published_values": 4200, "import_rows": 5570, "import_sheets": 2, "validation_issues": 17})
        counted_tables = [call[1].rsplit("/", 1)[1] for call in self.calls_to("GET")]
        self.assertEqual(counted_tables, ["imports", "dashboard_values", "import_rows", "import_sheets", "validation_issues"])
        for _, _, kwargs in self.calls_to("GET")[1:]:
            self.assertEqual(kwargs["params"]["import_id"], f"eq.{IMPORT_ID}")
            self.assertEqual(kwargs["headers"]["Prefer"], "count=exact")

    def test_impact_of_an_empty_table_is_zero(self):
        self.counts["validation_issues"] = 0
        body = self.request("GET", f"/imports/{IMPORT_ID}/impact").json()
        self.assertEqual(body["validation_issues"], 0)

    def test_impact_reports_when_there_is_no_original_file(self):
        self.import_records = [import_row(storage_path=None)]
        self.assertFalse(self.request("GET", f"/imports/{IMPORT_ID}/impact").json()["has_file"])

    def test_unknown_import_is_a_404(self):
        self.import_records = []
        response = self.request("GET", f"/imports/{IMPORT_ID}/impact")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "Importação não encontrada.")

    def test_an_id_that_is_not_a_uuid_never_reaches_supabase(self):
        for method, path in (("GET", "/imports/abc&status=eq.x/impact"), ("POST", "/imports/abc/unapprove"), ("POST", "/imports/abc/archive"), ("DELETE", "/imports/abc")):
            self.assertEqual(self.request(method, path).status_code, 404, path)
        self.assertEqual(self.calls, [])


    def test_unapprove_calls_the_rpc_for_an_approved_import(self):
        self.import_records = [import_row("approved")]
        self.rpc_response = FakeResponse({"import_id": IMPORT_ID, "status": "needs_review", "superseded_published_values": 4200, "superseded_observations": 4200})
        response = self.request("POST", f"/imports/{IMPORT_ID}/unapprove")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["superseded_published_values"], 4200)
        (_, url, kwargs), = self.calls_to("POST")
        self.assertEqual(url, "https://example.supabase.co/rest/v1/rpc/unapprove_import")
        self.assertEqual(kwargs["json"], {"selected_import_id": IMPORT_ID})

    def test_unapprove_refuses_an_import_that_is_not_approved(self):
        for status in ("needs_review", "draft", "archived"):
            self.calls.clear()
            self.import_records = [import_row(status)]
            response = self.request("POST", f"/imports/{IMPORT_ID}/unapprove")
            self.assertEqual(response.status_code, 409, status)
            self.assertEqual(self.calls_to("POST"), [], status)

    def test_unapprove_points_to_the_migration_when_the_function_is_missing(self):
        self.import_records = [import_row("approved")]
        self.rpc_response = FakeResponse({"code": "PGRST202"}, 404)
        response = self.request("POST", f"/imports/{IMPORT_ID}/unapprove")
        self.assertEqual(response.status_code, 503)
        self.assertIn("0027_import_lifecycle.sql", response.json()["detail"])

    def test_unapprove_surfaces_a_database_error(self):
        self.import_records = [import_row("approved")]
        self.rpc_response = FakeResponse({"message": "boom"}, 400)
        response = self.request("POST", f"/imports/{IMPORT_ID}/unapprove")
        self.assertEqual(response.status_code, 502)
        self.assertIn("boom", response.json()["detail"])


    def test_archive_sets_the_status_and_the_archive_date(self):
        response = self.request("POST", f"/imports/{IMPORT_ID}/archive")
        self.assertEqual(response.json(), {"import_id": IMPORT_ID, "status": "archived"})
        (_, url, kwargs), = self.calls_to("PATCH")
        self.assertEqual(url, "https://example.supabase.co/rest/v1/imports")
        self.assertEqual(kwargs["params"], {"id": f"eq.{IMPORT_ID}"})
        self.assertEqual(kwargs["json"]["status"], "archived")
        self.assertTrue(kwargs["json"]["archived_at"])

    def test_archiving_twice_is_harmless(self):
        self.import_records = [import_row("archived")]
        self.assertEqual(self.request("POST", f"/imports/{IMPORT_ID}/archive").status_code, 200)
        self.assertEqual(self.calls_to("PATCH"), [])

    def test_a_discarded_import_cannot_be_archived(self):
        self.import_records = [import_row("discarded")]
        self.assertEqual(self.request("POST", f"/imports/{IMPORT_ID}/archive").status_code, 409)
        self.assertEqual(self.calls_to("PATCH"), [])


    def test_delete_removes_the_rows_and_then_the_stored_file(self):
        self.rpc_response = FakeResponse({"import_id": IMPORT_ID, "published_values": 0, "import_rows": 5570, "imports": 1})
        response = self.request("DELETE", f"/imports/{IMPORT_ID}")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "deleted")
        self.assertEqual(body["deleted"]["import_rows"], 5570)
        self.assertTrue(body["storage_removed"])
        (_, rpc_url, rpc_kwargs), = self.calls_to("POST")
        self.assertEqual(rpc_url, "https://example.supabase.co/rest/v1/rpc/delete_import_cascade")
        self.assertEqual(rpc_kwargs["json"], {"selected_import_id": IMPORT_ID})
        (_, storage_url, _), = self.calls_to("DELETE")
        self.assertEqual(storage_url, f"https://example.supabase.co/storage/v1/object/source-files/imports/{IMPORT_ID}/original/pib%202021.xlsx")
        self.assertLess(self.calls.index(self.calls_to("POST")[0]), self.calls.index(self.calls_to("DELETE")[0]), "o arquivo só sai depois de o banco confirmar")

    def test_an_approved_import_needs_force(self):
        self.import_records = [import_row("approved")]
        response = self.request("DELETE", f"/imports/{IMPORT_ID}")
        self.assertEqual(response.status_code, 409)
        self.assertIn("aprovada", response.json()["detail"])
        self.assertEqual(self.calls_to("POST"), [])
        self.assertEqual(self.calls_to("DELETE"), [])

    def test_force_deletes_an_approved_import(self):
        self.import_records = [import_row("approved")]
        self.rpc_response = FakeResponse({"import_id": IMPORT_ID, "published_values": 4200})
        response = self.request("DELETE", f"/imports/{IMPORT_ID}?force=true")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["deleted"]["published_values"], 4200)

    def test_import_without_a_stored_file_skips_the_storage_call(self):
        self.import_records = [import_row(storage_path=None)]
        body = self.request("DELETE", f"/imports/{IMPORT_ID}").json()
        self.assertTrue(body["storage_removed"])
        self.assertEqual(self.calls_to("DELETE"), [])

    def test_a_storage_failure_is_reported_but_does_not_undo_the_deletion(self):
        self.storage_response = FakeResponse({"message": "down"}, 500)
        response = self.request("DELETE", f"/imports/{IMPORT_ID}")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["storage_removed"])

    def test_a_file_that_is_already_gone_counts_as_removed(self):
        self.storage_response = FakeResponse({"message": "not found"}, 404)
        self.assertTrue(self.request("DELETE", f"/imports/{IMPORT_ID}").json()["storage_removed"])

    def test_the_file_stays_when_the_database_refuses_the_deletion(self):
        self.rpc_response = FakeResponse({"message": "violates foreign key"}, 409)
        response = self.request("DELETE", f"/imports/{IMPORT_ID}")
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.calls_to("DELETE"), [])

    def test_delete_points_to_the_migration_when_the_function_is_missing(self):
        self.rpc_response = FakeResponse({"code": "PGRST202"}, 404)
        response = self.request("DELETE", f"/imports/{IMPORT_ID}")
        self.assertEqual(response.status_code, 503)
        self.assertIn("0027_import_lifecycle.sql", response.json()["detail"])
        self.assertEqual(self.calls_to("DELETE"), [])

    def test_a_database_timeout_is_a_504_and_keeps_the_file(self):
        def timing_out(url, **kwargs):
            self.calls.append(("POST", url, kwargs))
            raise httpx.ReadTimeout("slow")

        with patch.object(routes_import_lifecycle.httpx, "get", side_effect=self.fake_get), patch.object(routes_import_lifecycle.httpx, "post", side_effect=timing_out), patch.object(routes_import_lifecycle.httpx, "delete", side_effect=self.fake_delete):
            response = self.client.delete(f"/imports/{IMPORT_ID}")
        self.assertEqual(response.status_code, 504)
        self.assertEqual(self.calls_to("DELETE"), [])


if __name__ == "__main__":
    unittest.main()
