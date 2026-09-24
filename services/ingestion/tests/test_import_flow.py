import gzip
import unittest
from io import BytesIO
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import HTTPException
from fastapi.testclient import TestClient
from openpyxl import Workbook

from services.ingestion.app import main


def successful_response(response_json, headers=None):
    class Response:
        is_success = True
        status_code = 200

        def __init__(self):
            self.headers = headers or {}

        def json(self):
            return response_json

    return Response()


def failed_response(response_json):
    class Response:
        is_success = False
        status_code = 500
        headers = {}

        def json(self):
            return response_json

    return Response()


class SourceSizeLimitTests(unittest.TestCase):
    def test_compressed_files_cannot_expand_past_the_limit(self):
        compressed_content = gzip.compress(b"a" * 2048)
        with patch.object(main, "maximum_source_bytes", 1024):
            with self.assertRaises(HTTPException) as caught_error:
                main.read_table("dados.csv.gz", compressed_content)
        self.assertEqual(caught_error.exception.status_code, 413)

    def test_zip_members_larger_than_the_limit_are_rejected(self):
        archive_buffer = BytesIO()
        with ZipFile(archive_buffer, "w", ZIP_DEFLATED) as archive:
            archive.writestr("dados.csv", "valor\n" + "1\n" * 2048)
        with patch.object(main, "maximum_source_bytes", 1024):
            with self.assertRaises(HTTPException) as caught_error:
                main.read_table("dados.zip", archive_buffer.getvalue())
        self.assertEqual(caught_error.exception.status_code, 413)

    def test_uploads_larger_than_the_limit_are_rejected(self):
        with patch.object(main, "maximum_source_bytes", 16):
            response = TestClient(main.app).post("/profile", files={"file": ("dados.csv", "valor\n" + "1\n" * 32, "text/csv")})
        self.assertEqual(response.status_code, 413)


class UploadTokenTests(unittest.TestCase):
    def setUp(self):
        main.source_cache.clear()

    def workbook_content(self) -> bytes:
        workbook = Workbook()
        first_sheet = workbook.active
        first_sheet.title = "Base"
        first_sheet.append(["codigo_ibge", "ano", "valor"])
        first_sheet.append(["3550308", 2024, 10])
        second_sheet = workbook.create_sheet("Outra")
        second_sheet.append(["codigo_ibge", "valor"])
        second_sheet.append(["3509502", 5])
        second_sheet.append(["3304557", 7])
        workbook_buffer = BytesIO()
        workbook.save(workbook_buffer)
        return workbook_buffer.getvalue()

    @patch("services.ingestion.app.main.assess_source", return_value={"status": "skipped", "summary": "ok"})
    def test_sheet_changes_reuse_the_uploaded_file(self, assess_source):
        client = TestClient(main.app)
        first_response = client.post("/profile", files={"file": ("dados.xlsx", self.workbook_content(), "application/octet-stream")}, data={"sheet_name": "Base"})
        upload_token = first_response.json()["upload_token"]

        second_response = client.post("/profile", data={"upload_token": upload_token, "sheet_name": "Outra"})

        self.assertEqual(second_response.status_code, 200)
        self.assertEqual(second_response.json()["selected_sheet"], "Outra")
        self.assertEqual(second_response.json()["rows"], 2)
        self.assertEqual(second_response.json()["upload_token"], upload_token)
        self.assertEqual(set(main.source_cache[upload_token]["profiles"]), {"Base", "Outra"})

    def test_expired_tokens_ask_for_the_file_again(self):
        response = TestClient(main.app).post("/profile", data={"upload_token": "missing"})
        self.assertEqual(response.status_code, 410)

    def test_cache_evicts_the_oldest_sources_when_full(self):
        with patch.object(main, "source_cache_max_bytes", 10):
            first_token = main.remember_source("a.csv", b"123456", None)
            second_token = main.remember_source("b.csv", b"123456", None)
        self.assertNotIn(first_token, main.source_cache)
        self.assertIn(second_token, main.source_cache)

    @patch("services.ingestion.app.main.persist_import")
    def test_draft_uses_the_profile_already_computed(self, persist_import):
        upload_token = main.remember_source("dados.csv", b"valor\n1\n", None)
        main.source_cache[upload_token]["profiles"][""] = {"file_name": "dados.csv"}
        persist_import.return_value = {"import_id": "import-id"}

        main.persist_cached_source(upload_token, None, None, None, None, False)

        self.assertEqual(persist_import.call_args.args[8], {"": {"file_name": "dados.csv"}})
        self.assertEqual(persist_import.call_args.args[4], "dados.csv")


class PartialImportCleanupTests(unittest.TestCase):
    @patch("services.ingestion.app.main.supabase_headers", return_value={})
    @patch("services.ingestion.app.main.supabase_url", side_effect=lambda path: f"https://supabase.test{path}")
    @patch("services.ingestion.app.main.httpx.delete")
    @patch("services.ingestion.app.main.httpx.post")
    def test_failed_row_staging_removes_what_was_already_written(self, post_request, delete_request, supabase_url, supabase_headers):
        post_request.side_effect = [
            successful_response([{"id": "source-id"}]),
            successful_response([{"id": "import-id"}]),
            successful_response([]),
            failed_response({"message": "violates constraint"}),
        ]
        delete_request.return_value = successful_response([])
        cached_profiles = {"": {"columns": [], "sample": []}}

        with self.assertRaises(HTTPException) as caught_error:
            main.persist_import("dados.csv", b"valor\n1\n", None, None, "Dados", None, None, False, cached_profiles)

        self.assertIn("violates constraint", caught_error.exception.detail)
        deleted_urls = [call.args[0] for call in delete_request.call_args_list]
        self.assertEqual(deleted_urls, ["https://supabase.test/storage/v1/object/source-files/imports/import-id/original/dados.csv", "https://supabase.test/rest/v1/imports", "https://supabase.test/rest/v1/sources"])


class DashboardValuesTests(unittest.TestCase):
    def test_total_comes_from_the_content_range_header(self):
        self.assertEqual(main.total_from_content_range("0-199/1234", 200), 1234)
        self.assertEqual(main.total_from_content_range("*/0", 0), 0)
        self.assertEqual(main.total_from_content_range(None, 17), 17)

    @patch("services.ingestion.app.main.supabase_headers", return_value={})
    @patch("services.ingestion.app.main.supabase_url", side_effect=lambda path: f"https://supabase.test{path}")
    @patch("services.ingestion.app.main.httpx.get")
    def test_values_are_paginated_and_receive_municipality_names(self, get_request, supabase_url, supabase_headers):
        get_request.side_effect = [
            successful_response([{"id": "1", "dimensions": {"municipality_ibge_code": "3550308"}}], {"content-range": "0-0/900"}),
            successful_response([{"ibge_code": "3550308", "name": "São Paulo", "state": "SP"}]),
        ]

        result = main.list_dashboard_values(limit=1, offset=0)

        self.assertEqual(result["total"], 900)
        self.assertEqual(result["items"][0]["municipality_name"], "São Paulo (SP)")


    @patch("services.ingestion.app.main.supabase_headers", return_value={})
    @patch("services.ingestion.app.main.supabase_url", side_effect=lambda path: f"https://supabase.test{path}")
    @patch("services.ingestion.app.main.httpx.get")
    def test_values_still_load_before_the_granularity_migration(self, get_request, supabase_url, supabase_headers):
        missing_column = failed_response({"message": "column dashboard_values.period_granularity does not exist"})
        missing_column.status_code = 400
        get_request.side_effect = [missing_column, successful_response([{"id": "1", "dimensions": {}}], {"content-range": "0-0/1"})]

        result = main.list_dashboard_values()

        self.assertIn("period_granularity", get_request.call_args_list[0].kwargs["params"]["select"])
        self.assertNotIn("period_granularity", get_request.call_args_list[1].kwargs["params"]["select"])
        self.assertEqual(result["total"], 1)


class IiuCoverageTests(unittest.TestCase):
    @patch("services.ingestion.app.main.supabase_headers", return_value={})
    @patch("services.ingestion.app.main.supabase_url", side_effect=lambda path: f"https://supabase.test{path}")
    @patch("services.ingestion.app.main.httpx.get")
    def test_values_outside_the_iiu_catalog_do_not_count_as_coverage(self, get_request, supabase_url, supabase_headers):
        catalog = [{"code": "a", "name": "A", "iiu_type": "q", "unit": "%", "formula": "", "source_description": "", "score_direction": "higher", "iiu_dimension_code": "d1", "checklist_max": None}]
        dimensions = [{"code": "d1", "name": "D1", "color": "#fff", "weight": 100}]
        values = [
            {"indicator_code": "a", "value": 50, "reference_period": "2024-01-01", "unit": "%", "source_name": "s", "import_title": "i"},
            {"indicator_code": "outro", "value": 1, "reference_period": "2024-01-01", "unit": "%", "source_name": "s", "import_title": "i"},
        ]
        get_request.side_effect = [successful_response(catalog), successful_response(dimensions), successful_response([]), successful_response(values)]

        dashboard = main.get_iiu_dashboard("3550308")

        self.assertEqual(dashboard["observed_indicators"], 1)
        self.assertEqual(dashboard["total_indicators"], 1)


if __name__ == "__main__":
    unittest.main()
