import unittest
from unittest.mock import patch

from fastapi import HTTPException

from services.ingestion.app import main


def successful_response(response_json):
    class Response:
        is_success = True
        status_code = 200

        def json(self):
            return response_json

    return Response()


def staged_row(row_number, raw_row, normalized_row=None):
    return {"id": row_number, "sheet_name": "Dados", "row_number": row_number, "raw_row": raw_row, "normalized_row": normalized_row or {}}


catalog = [
    {"ibge_code": "3550308", "name": "São Paulo", "state": "SP"},
    {"ibge_code": "3509502", "name": "Campinas", "state": "SP"},
    {"ibge_code": "1100015", "name": "Alta Floresta D'Oeste", "state": "RO"},
]


class MunicipalityFormatTests(unittest.TestCase):
    def test_common_name_formats_carry_the_state(self):
        cases = {"Campinas (SP)": ("Campinas", "SP"), "Ro-Alta Floresta D Oeste": ("Alta Floresta D Oeste", "RO"), "Ro-Ji-Parana": ("Ji-Parana", "RO"), "Pau d Arco - PA": ("Pau d Arco", "PA"), "Belém/PA": ("Belém", "PA")}
        for original_name, expected in cases.items():
            with self.subTest(original_name=original_name):
                self.assertEqual(main.parse_municipality_name(original_name), expected)
        for original_name in ("Ji-Paraná", "Xique-Xique", "Campinas"):
            with self.subTest(original_name=original_name):
                self.assertIsNone(main.parse_municipality_name(original_name))

    def test_six_digit_codes_are_resolved_through_the_official_catalog(self):
        resolve = main.municipality_code_resolver(catalog)
        values = ("110001", 110001, "110001.0", "1100015", "355030", "999999", "9999999", "abc")
        self.assertEqual([resolve(value) for value in values], ["1100015", "1100015", "1100015", "1100015", "3550308", None, None, None])

    def test_code_columns_are_recognized(self):
        self.assertTrue(all(main.is_municipality_code_column(name) for name in ("codigo_do_municipio", "cod_municipio", "codigo_ibge", "cod_mun")))
        self.assertFalse(any(main.is_municipality_code_column(name) for name in ("municipio", "uf", "codigo_do_indicador")))

    def test_lookup_accepts_codes_and_state_prefixed_names(self):
        indexes = main.municipality_indexes(catalog)
        self.assertEqual(main.municipality_candidates("110001", indexes), ("matched", [catalog[2]]))
        self.assertEqual(main.municipality_candidates("Ro-Alta Floresta D Oeste", indexes), ("matched", [catalog[2]]))


@patch("services.ingestion.app.main.ensure_municipal_catalog_registered")
@patch("services.ingestion.app.main.ibge_municipality_catalog", return_value=catalog)
@patch("services.ingestion.app.main.supabase_headers", return_value={})
@patch("services.ingestion.app.main.supabase_url", side_effect=lambda path: f"https://supabase.test{path}")
class ApprovalOrchestrationTests(unittest.TestCase):
    @patch("services.ingestion.app.main.fetch_rows_for_municipality_resolution")
    @patch("services.ingestion.app.main.httpx.post")
    def test_approval_prepares_municipality_period_and_value_before_calling_the_database(self, post_request, fetch_rows, *_):
        fetch_rows.return_value = [
            staged_row(1, {"cod": "3550308", "valor": "12,5%"}),
            staged_row(2, {"cod": "110001", "valor": "sigiloso"}),
            staged_row(3, {"cod": "999999", "valor": "4"}),
        ]
        post_request.side_effect = [successful_response([]), successful_response(1)]

        result = main.approve_municipal_import("import-id", main.MunicipalApproval(indicator_id="indicator-id", municipality_field="cod", value_field="valor", unit="%", sheet_name="Dados", period=main.PeriodSelection(mode="fixed", fixed_year=2024)))

        rows_call, approval_call = post_request.call_args_list
        self.assertEqual([row["normalized_row"] for row in rows_call.kwargs["json"]], [
            {"approval_municipality_ibge_code": "3550308", "reference_year": "2024", "value": "12.5"},
            {"approval_municipality_ibge_code": "1100015", "reference_year": "2024", "value": None},
            {"approval_municipality_ibge_code": None, "reference_year": "2024", "value": "4"},
        ])
        self.assertEqual(approval_call.args[0], "https://supabase.test/rest/v1/rpc/approve_municipal_import")
        rpc_fields = approval_call.kwargs["json"]
        self.assertEqual((rpc_fields["municipality_field"], rpc_fields["year_field"], rpc_fields["value_field"]), ("approval_municipality_ibge_code", "reference_year", "value"))
        self.assertEqual(result["value_problems"], [{"row_number": 2, "value": "sigiloso"}])
        self.assertEqual(result["municipality_problems"], [{"row_number": 3, "value": "999999"}])

    @patch("services.ingestion.app.main.fetch_rows_for_municipality_resolution")
    @patch("services.ingestion.app.main.httpx.post", return_value=successful_response(40))
    def test_rows_already_prepared_go_straight_to_the_database(self, post_request, fetch_rows, *_):
        result = main.approve_municipal_import("import-id", main.MunicipalApproval(indicator_id="i", municipality_field="municipality_ibge_code", value_field="value", unit="u", sheet_name="Aba · saldos por período", period=main.PeriodSelection(mode="prepared")))

        fetch_rows.assert_not_called()
        self.assertEqual(post_request.call_args.kwargs["json"]["municipality_field"], "municipality_ibge_code")
        self.assertEqual(result["approved_rows"], 40)

    def test_legacy_requests_with_only_a_year_column_still_work(self, *_):
        with patch("services.ingestion.app.main.fetch_rows_for_municipality_resolution", return_value=[]), patch("services.ingestion.app.main.upsert_staged_rows"), patch("services.ingestion.app.main.httpx.post", return_value=successful_response(0)):
            result = main.approve_municipal_import("import-id", main.MunicipalApproval(indicator_id="i", municipality_field="cod", year_field="ano", value_field="valor", unit="u"))
        self.assertEqual(result["status"], "needs_review")


class CatalogRegistrationTests(unittest.TestCase):
    def setUp(self):
        main.municipal_catalog_registration["registered_until"] = 0.0

    @patch("services.ingestion.app.main.supabase_headers", return_value={})
    @patch("services.ingestion.app.main.supabase_url", side_effect=lambda path: f"https://supabase.test{path}")
    @patch("services.ingestion.app.main.ibge_municipality_catalog", return_value=catalog * 500)
    @patch("services.ingestion.app.main.httpx.post", return_value=successful_response(1000))
    def test_the_whole_catalog_is_registered_once_in_batches(self, post_request, *_):
        main.ensure_municipal_catalog_registered()
        main.ensure_municipal_catalog_registered()

        self.assertEqual(post_request.call_count, 2)
        self.assertEqual(len(post_request.call_args_list[0].kwargs["json"]["selected_municipalities"]), 1000)


@patch("services.ingestion.app.main.ensure_municipal_catalog_registered")
@patch("services.ingestion.app.main.supabase_headers", return_value={})
@patch("services.ingestion.app.main.supabase_url", side_effect=lambda path: f"https://supabase.test{path}")
class PeriodExpansionTests(unittest.TestCase):
    @patch("services.ingestion.app.main.httpx.get")
    @patch("services.ingestion.app.main.httpx.post")
    def test_a_measure_becomes_a_new_sheet_with_one_row_per_period(self, post_request, get_request, *_):
        get_request.side_effect = [
            successful_response([{"sheet_name": "Tabela 3", "sheet_position": 3, "columns_profile": [{"name": "uf"}, {"name": "codigo_do_municipio"}, {"name": "municipio"}, {"name": "janeiro_2020_saldos"}]}]),
            successful_response([{"municipio": "Ro-Ariquemes", "competencia": "2020-01-01", "valor": -55}]),
        ]
        post_request.side_effect = [successful_response([{"created_rows": 790, "empty_cells": 0, "unresolved_rows": 0}]), successful_response([])]

        result = main.expand_import_periods("import-id", main.PeriodExpansion(sheet_name="Tabela 3", municipality_field="codigo_do_municipio", measure_label="saldos", period_fields=["janeiro_2020_saldos", "fevereiro_2020_saldos", "julho_2026_saldos"]))

        expansion_call, sheet_call = post_request.call_args_list
        self.assertEqual(expansion_call.args[0], "https://supabase.test/rest/v1/rpc/expand_import_periods")
        self.assertEqual(expansion_call.kwargs["json"]["period_columns"], [{"field": "janeiro_2020_saldos", "year": 2020, "month": 1}, {"field": "fevereiro_2020_saldos", "year": 2020, "month": 2}, {"field": "julho_2026_saldos", "year": 2026, "month": 7}])
        self.assertEqual(expansion_call.kwargs["json"]["identity_fields"], ["codigo_do_municipio", "uf", "municipio"])
        self.assertEqual(sheet_call.kwargs["json"][0]["sheet_position"], 4)
        self.assertEqual((result["sheet_name"], result["periods"], result["granularity"]), ("Tabela 3 · saldos por período", 3, "month"))

    @patch("services.ingestion.app.main.httpx.get")
    @patch("services.ingestion.app.main.httpx.post")
    def test_csv_imports_get_their_source_sheet_registered_first(self, post_request, get_request, *_):
        get_request.side_effect = [
            successful_response([]),
            successful_response([{"profile": {"columns": [{"name": "cod"}], "sample": [{"cod": "110001"}]}, "total_rows": 5}]),
            successful_response([]),
        ]
        post_request.side_effect = [successful_response([]), successful_response([{"created_rows": 10, "empty_cells": 0, "unresolved_rows": 0}]), successful_response([])]

        main.expand_import_periods("import-id", main.PeriodExpansion(municipality_field="cod", measure_label="valor", period_fields=["valor_2021", "valor_2022"]))

        source_call = post_request.call_args_list[0]
        self.assertEqual((source_call.kwargs["json"][0]["sheet_name"], source_call.kwargs["json"][0]["row_count"]), ("Dados", 5))
        self.assertEqual(post_request.call_args_list[2].kwargs["json"][0]["sheet_position"], 2)

    def test_columns_without_a_period_are_rejected(self, *_):
        with self.assertRaises(HTTPException):
            main.expand_import_periods("import-id", main.PeriodExpansion(municipality_field="cod", measure_label="x", period_fields=["acumulado_do_ano_(2026)_saldos"]))


if __name__ == "__main__":
    unittest.main()
