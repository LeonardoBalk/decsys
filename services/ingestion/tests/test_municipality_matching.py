import unittest
from unittest.mock import patch

from fastapi import HTTPException

from services.ingestion.app import main


class MunicipalityMatchingTests(unittest.TestCase):
    municipalities = [
        {"ibge_code": "3509502", "name": "Campinas", "state": "SP"},
        {"ibge_code": "3550308", "name": "São Paulo", "state": "SP"},
        {"ibge_code": "4302105", "name": "Bom Jesus", "state": "RS"},
        {"ibge_code": "4302303", "name": "Bom Jesus", "state": "RS"},
    ]

    def setUp(self):
        main.ibge_catalog_cache.update({"expires_at": 0.0, "catalog": []})

    def test_municipality_names_are_normalized_without_accents_or_case(self):
        self.assertEqual(main.normalize_municipality_name("  SÃO   Paulo "), "sao paulo")
        self.assertEqual(main.parse_municipality_name("Campinas (SP)"), ("Campinas", "SP"))
        self.assertIsNone(main.parse_municipality_name("Campinas"))

    @patch("services.ingestion.app.main.httpx.get")
    def test_ibge_catalog_supports_municipalities_without_a_microregion(self, get_request):
        response = successful_response([{"id": 5101837, "nome": "Boa Esperança do Norte", "microrregiao": None, "regiao-imediata": {"regiao-intermediaria": {"UF": {"sigla": "MT"}}}}])
        get_request.return_value = response

        municipality_catalog = main.fetch_ibge_municipalities()

        self.assertEqual(municipality_catalog, [{"ibge_code": "5101837", "name": "Boa Esperança do Norte", "state": "MT"}])

    @patch("services.ingestion.app.main.fetch_ibge_municipalities")
    def test_ibge_catalog_is_fetched_once_and_reused(self, fetch_catalog):
        fetch_catalog.return_value = self.municipalities

        main.ibge_municipality_catalog()
        main.ibge_municipality_catalog()

        fetch_catalog.assert_called_once()

    @patch("services.ingestion.app.main.fetch_rows_for_municipality_resolution")
    @patch("services.ingestion.app.main.fetch_ibge_municipalities")
    def test_suggestions_match_exact_city_and_state_and_flag_ambiguous_rows(self, fetch_catalog, fetch_rows):
        fetch_catalog.return_value = self.municipalities
        fetch_rows.return_value = [
            {"row_number": 1, "raw_row": {"municipio": "Campinas (SP)"}},
            {"row_number": 2, "raw_row": {"municipio": "São Paulo (SP)"}},
            {"row_number": 3, "raw_row": {"municipio": "Bom Jesus (RS)"}},
            {"row_number": 4, "raw_row": {"municipio": "Campinas"}},
            {"row_number": 5, "raw_row": {"municipio": "Cidade Inexistente"}},
        ]

        result = main.suggest_municipality_matches("import-id", main.MunicipalityResolution(municipality_field="municipio", sheet_name="Dados"))

        self.assertEqual(result["matched_count"], 2)
        self.assertEqual(result["matches"][0]["suggestion"]["ibge_code"], "3509502")
        self.assertEqual(result["matches"][1]["suggestion"]["ibge_code"], "3550308")
        self.assertEqual(result["matches"][2]["status"], "ambiguous")
        self.assertEqual(len(result["matches"][2]["candidates"]), 2)
        self.assertEqual(result["matches"][3]["status"], "ambiguous")
        self.assertEqual([candidate["ibge_code"] for candidate in result["matches"][3]["candidates"]], ["3509502"])
        self.assertEqual(result["matches"][4]["status"], "unmatched")

    @patch("services.ingestion.app.main.httpx.post")
    @patch("services.ingestion.app.main.supabase_headers", return_value={})
    @patch("services.ingestion.app.main.supabase_url", side_effect=lambda path: f"https://supabase.test{path}")
    @patch("services.ingestion.app.main.fetch_rows_for_municipality_resolution")
    @patch("services.ingestion.app.main.fetch_ibge_municipalities")
    def test_confirmed_matches_register_official_municipality_and_preserve_other_normalized_fields(self, fetch_catalog, fetch_rows, supabase_url, supabase_headers, post_request):
        fetch_catalog.return_value = self.municipalities
        fetch_rows.return_value = [{"id": 15, "sheet_name": "Dados", "row_number": 1, "raw_row": {"municipio": "Campinas (SP)"}, "normalized_row": {"value": "12.5", "reference_year": "2024"}}]
        post_request.return_value = successful_response([])

        result = main.apply_municipality_matches("import-id", main.MunicipalityResolution(municipality_field="municipio", sheet_name="Dados", matches=[main.MunicipalityMatch(row_number=1, ibge_code="3509502")]))

        self.assertEqual(result["applied_count"], 1)
        municipality_call, rows_call = post_request.call_args_list
        self.assertEqual(municipality_call.args[0], "https://supabase.test/rest/v1/rpc/register_municipalities")
        self.assertEqual(municipality_call.kwargs["json"], {"selected_municipalities": [{"ibge_code": "3509502", "name": "Campinas", "state": "SP"}]})
        self.assertEqual(rows_call.kwargs["params"], {"on_conflict": "id"})
        self.assertEqual(rows_call.kwargs["json"][0]["normalized_row"], {"value": "12.5", "reference_year": "2024", "municipality_ibge_code": "3509502", "municipality_code_source": "ibge_lookup"})
        self.assertEqual(rows_call.kwargs["json"][0]["sheet_name"], "Dados")

    @patch("services.ingestion.app.main.httpx.post")
    @patch("services.ingestion.app.main.supabase_headers", return_value={})
    @patch("services.ingestion.app.main.supabase_url", side_effect=lambda path: f"https://supabase.test{path}")
    @patch("services.ingestion.app.main.fetch_rows_for_municipality_resolution")
    @patch("services.ingestion.app.main.fetch_ibge_municipalities")
    def test_reviewer_can_choose_a_candidate_or_type_an_official_code(self, fetch_catalog, fetch_rows, supabase_url, supabase_headers, post_request):
        fetch_catalog.return_value = self.municipalities
        fetch_rows.return_value = [
            {"id": 1, "sheet_name": "Dados", "row_number": 1, "raw_row": {"municipio": "Bom Jesus (RS)"}, "normalized_row": {}},
            {"id": 2, "sheet_name": "Dados", "row_number": 2, "raw_row": {"municipio": "Sampa"}, "normalized_row": {}},
        ]
        post_request.return_value = successful_response([])

        result = main.apply_municipality_matches("import-id", main.MunicipalityResolution(municipality_field="municipio", sheet_name="Dados", matches=[
            main.MunicipalityMatch(row_number=1, ibge_code="4302303", origin="candidate"),
            main.MunicipalityMatch(row_number=2, ibge_code="3550308", origin="manual"),
        ]))

        self.assertEqual(result["applied_count"], 2)
        self.assertEqual([row["normalized_row"]["municipality_ibge_code"] for row in post_request.call_args_list[1].kwargs["json"]], ["4302303", "3550308"])

    @patch("services.ingestion.app.main.httpx.post")
    @patch("services.ingestion.app.main.fetch_rows_for_municipality_resolution")
    @patch("services.ingestion.app.main.fetch_ibge_municipalities")
    def test_confirmation_rejects_a_code_that_does_not_match_the_source_name(self, fetch_catalog, fetch_rows, post_request):
        fetch_catalog.return_value = self.municipalities
        fetch_rows.return_value = [{"id": 15, "row_number": 1, "raw_row": {"municipio": "Campinas (SP)"}, "normalized_row": {}}]

        for origin in ("exact", "candidate"):
            with self.subTest(origin=origin):
                with self.assertRaises(HTTPException) as caught_error:
                    main.apply_municipality_matches("import-id", main.MunicipalityResolution(municipality_field="municipio", matches=[main.MunicipalityMatch(row_number=1, ibge_code="3550308", origin=origin)]))
                self.assertEqual(caught_error.exception.status_code, 422)
        post_request.assert_not_called()

    @patch("services.ingestion.app.main.httpx.post")
    @patch("services.ingestion.app.main.fetch_rows_for_municipality_resolution")
    @patch("services.ingestion.app.main.fetch_ibge_municipalities")
    def test_manual_code_must_exist_in_the_official_catalog(self, fetch_catalog, fetch_rows, post_request):
        fetch_catalog.return_value = self.municipalities
        fetch_rows.return_value = [{"id": 15, "row_number": 1, "raw_row": {"municipio": "Sampa"}, "normalized_row": {}}]

        with self.assertRaises(HTTPException) as caught_error:
            main.apply_municipality_matches("import-id", main.MunicipalityResolution(municipality_field="municipio", matches=[main.MunicipalityMatch(row_number=1, ibge_code="9999999", origin="manual")]))

        self.assertEqual(caught_error.exception.status_code, 422)
        post_request.assert_not_called()

    @patch("services.ingestion.app.main.httpx.post")
    @patch("services.ingestion.app.main.supabase_headers", return_value={})
    @patch("services.ingestion.app.main.supabase_url", side_effect=lambda path: f"https://supabase.test{path}")
    @patch("services.ingestion.app.main.fetch_rows_for_municipality_resolution")
    @patch("services.ingestion.app.main.fetch_ibge_municipalities")
    def test_confirming_again_clears_codes_the_reviewer_removed(self, fetch_catalog, fetch_rows, supabase_url, supabase_headers, post_request):
        fetch_catalog.return_value = self.municipalities
        fetch_rows.return_value = [
            {"id": 1, "sheet_name": "Dados", "row_number": 1, "raw_row": {"municipio": "Campinas (SP)"}, "normalized_row": {"municipality_ibge_code": "3509502", "municipality_code_source": "ibge_lookup"}},
            {"id": 2, "sheet_name": "Dados", "row_number": 2, "raw_row": {"municipio": "Sampa"}, "normalized_row": {"municipality_ibge_code": "3550308", "municipality_code_source": "ibge_lookup", "value": "4"}},
            {"id": 3, "sheet_name": "Dados", "row_number": 3, "raw_row": {"municipio": "3304557"}, "normalized_row": {"municipality_ibge_code": "3304557"}},
        ]
        post_request.return_value = successful_response([])

        main.apply_municipality_matches("import-id", main.MunicipalityResolution(municipality_field="municipio", sheet_name="Dados", matches=[main.MunicipalityMatch(row_number=1, ibge_code="3509502")]))

        saved_rows = {row["row_number"]: row["normalized_row"] for row in post_request.call_args_list[1].kwargs["json"]}
        self.assertEqual(saved_rows[2], {"value": "4"})
        self.assertNotIn(3, saved_rows)

    @patch("services.ingestion.app.main.fetch_ibge_municipalities")
    def test_catalog_search_accepts_names_states_and_codes(self, fetch_catalog):
        fetch_catalog.return_value = self.municipalities

        self.assertEqual([item["ibge_code"] for item in main.search_ibge_municipalities("camp")], ["3509502"])
        self.assertEqual([item["ibge_code"] for item in main.search_ibge_municipalities("Bom Jesus (RS)")], ["4302105", "4302303"])
        self.assertEqual([item["ibge_code"] for item in main.search_ibge_municipalities("355")], ["3550308"])
        self.assertEqual(main.search_ibge_municipalities("s"), [])


def successful_response(response_json):
    class Response:
        is_success = True
        status_code = 200

        def json(self):
            return response_json

    return Response()


if __name__ == "__main__":
    unittest.main()
