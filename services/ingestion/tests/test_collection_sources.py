import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from services.ingestion.app import main

VALID_LINK_SOURCE = {
    "dimension": "Economia",
    "factor": "Produtividade",
    "name": "PIB per capita",
    "source": "IBGE",
    "access": "link",
    "importUrl": "https://apisidra.ibge.gov.br/values/t/5938/n6/all/v/37/p/last",
    "steps": "Cole o link e filtre o município.",
    "needs": [" população ", ""],
}


def stored_row(**overrides):
    row = {"code": "ECO99", "dimension": "Economia", "factor": "Produtividade", "name": "PIB per capita", "definition": "", "unit": "", "source": "IBGE", "official_link": None, "access": "link", "import_url": VALID_LINK_SOURCE["importUrl"], "manual_url": None, "steps": "Cole o link e filtre o município.", "needs": ["população"], "notes": None, "verified_on": "2026-10-08"}
    row.update(overrides)
    return row


def supabase_response(rows, status_code=200):
    response = Mock()
    response.status_code = status_code
    response.is_success = 200 <= status_code < 300
    response.json.return_value = rows
    response.text = ""
    return response


@patch.dict("os.environ", {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "chave"})
class CollectionSourcesTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def test_save_normalizes_code_trims_needs_and_stamps_verification_date(self):
        with patch.object(main.httpx, "post", return_value=supabase_response([stored_row()])) as post:
            response = self.client.put("/collection-sources/eco99", json=VALID_LINK_SOURCE)
        self.assertEqual(response.status_code, 200)
        sent = post.call_args.kwargs["json"]
        self.assertEqual(sent["code"], "ECO99")
        self.assertEqual(sent["needs"], ["população"])
        self.assertRegex(sent["verified_on"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertEqual(response.json()["importUrl"], VALID_LINK_SOURCE["importUrl"])

    def test_link_source_requires_import_url(self):
        body = {**VALID_LINK_SOURCE, "importUrl": ""}
        with patch.object(main.httpx, "post") as post:
            response = self.client.put("/collection-sources/ECO99", json=body)
        self.assertEqual(response.status_code, 422)
        post.assert_not_called()

    def test_links_must_be_https(self):
        with patch.object(main.httpx, "post") as post:
            response = self.client.put("/collection-sources/ECO99", json={**VALID_LINK_SOURCE, "importUrl": "http://insegura.example/dados.csv"})
        self.assertEqual(response.status_code, 422)
        post.assert_not_called()

    def test_manual_source_drops_import_url(self):
        body = {**VALID_LINK_SOURCE, "access": "manual", "manualUrl": "https://example.gov.br/dados"}
        with patch.object(main.httpx, "post", return_value=supabase_response([stored_row(access="manual", import_url=None, manual_url="https://example.gov.br/dados")])) as post:
            response = self.client.put("/collection-sources/ECO99", json=body)
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(post.call_args.kwargs["json"]["import_url"])

    def test_invalid_code_and_missing_required_fields_are_rejected(self):
        self.assertEqual(self.client.put("/collection-sources/a-b", json=VALID_LINK_SOURCE).status_code, 422)
        self.assertEqual(self.client.put("/collection-sources/ECO99", json={**VALID_LINK_SOURCE, "steps": "  "}).status_code, 422)
        self.assertEqual(self.client.put("/collection-sources/ECO99", json={**VALID_LINK_SOURCE, "access": "outro"}).status_code, 422)

    def test_list_returns_camel_case_items(self):
        with patch.object(main.httpx, "get", return_value=supabase_response([stored_row()])):
            response = self.client.get("/collection-sources")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()[0]["code"], "ECO99")
        self.assertEqual(response.json()[0]["verifiedOn"], "2026-10-08")

    def test_missing_table_points_to_the_migration(self):
        with patch.object(main.httpx, "get", return_value=supabase_response({}, 404)):
            response = self.client.get("/collection-sources")
        self.assertEqual(response.status_code, 503)
        self.assertIn("0021_collection_sources", response.json()["detail"])

    def test_delete_filters_by_code(self):
        with patch.object(main.httpx, "delete", return_value=supabase_response([], 204)) as delete:
            response = self.client.delete("/collection-sources/eco99")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(delete.call_args.kwargs["params"], {"code": "eq.ECO99"})


if __name__ == "__main__":
    unittest.main()
