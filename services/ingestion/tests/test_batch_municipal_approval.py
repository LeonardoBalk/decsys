import unittest
from decimal import Decimal
from unittest.mock import patch

from fastapi.testclient import TestClient

from services.ingestion.app import main


def staged_row(row_number, raw_row, normalized_row=None):
    return {"id": row_number, "sheet_name": "Dados", "row_number": row_number, "raw_row": raw_row, "normalized_row": normalized_row or {}}


class BatchMunicipalPreparationTests(unittest.TestCase):
    def setUp(self):
        self.period = main.PeriodSelection(mode="year_column", year_field="ano")
        self.mappings = [
            {"indicator_id": "employment", "indicator_code": "empregos_formais", "calculation_type": "direct", "value_field": "estoque", "prepared_field": "decsys_value__empregos_formais", "calculation_multiplier": 1},
            {"indicator_id": "rate", "indicator_code": "taxa_admissao", "calculation_type": "ratio", "numerator_field": "admissoes", "denominator_field": "estoque", "prepared_field": "decsys_value__taxa_admissao", "calculation_multiplier": 100},
        ]

    def test_prepares_several_measures_from_one_raw_row_and_keeps_provenance(self):
        source_rows = [staged_row(1, {"municipio": "3509502", "ano": "2023", "estoque": "1.234", "admissoes": "123,4"})]

        prepared_rows, summary = main.prepare_rows_for_batch_approval(source_rows, self.period, self.mappings, "municipio", lambda code: code)

        normalized_row = prepared_rows[0][1]
        self.assertEqual(normalized_row["approval_municipality_ibge_code"], "3509502")
        self.assertEqual(normalized_row["reference_year"], "2023")
        self.assertEqual(normalized_row["decsys_value__empregos_formais"], "1234")
        self.assertEqual(normalized_row["decsys_value__taxa_admissao"], "10")
        self.assertEqual(normalized_row["indicator_values"], {"empregos_formais": "1234", "taxa_admissao": "10"})
        self.assertEqual(normalized_row["indicator_calculations"]["taxa_admissao"]["type"], "ratio")
        self.assertEqual(summary["period_problems"], [])
        self.assertEqual(summary["municipality_problems"], [])
        self.assertEqual(summary["indicator_problems"]["employment"]["value_problem_count"], 0)

    def test_reports_bad_values_independently_for_each_indicator(self):
        source_rows = [staged_row(1, {"municipio": "3509502", "ano": "2023", "estoque": "texto", "admissoes": "12", "denominador": "0"})]
        ratio_mapping = {**self.mappings[1], "denominator_field": "denominador"}

        prepared_rows, summary = main.prepare_rows_for_batch_approval(source_rows, self.period, [self.mappings[0], ratio_mapping], "municipio", lambda code: code)

        self.assertIsNone(prepared_rows[0][1]["decsys_value__empregos_formais"])
        self.assertIsNone(prepared_rows[0][1]["decsys_value__taxa_admissao"])
        self.assertEqual(summary["indicator_problems"]["employment"]["value_problem_count"], 1)
        self.assertEqual(summary["indicator_problems"]["rate"]["value_problem_count"], 1)

    def test_merges_new_indicator_values_with_previous_preparation(self):
        source_rows = [staged_row(1, {"municipio": "3509502", "ano": "2023", "estoque": "1.234", "admissoes": "123,4"}, {"indicator_values": {"anterior": "7"}, "custom_note": "mantida"})]

        prepared_rows, _ = main.prepare_rows_for_batch_approval(source_rows, self.period, self.mappings, "municipio", lambda code: code)

        self.assertEqual(prepared_rows[0][1]["indicator_values"]["anterior"], "7")
        self.assertEqual(prepared_rows[0][1]["custom_note"], "mantida")

    def test_batch_approval_endpoint_persists_one_batch_and_returns_per_indicator_counts(self):
        indicators = [
            {"id": "employment", "code": "empregos_formais", "name": "Empregos formais", "active": True, "calculation_type": "direct", "unit": "pessoas"},
            {"id": "rate", "code": "taxa_admissao", "name": "Taxa de admissao", "active": True, "calculation_type": "ratio", "calculation_multiplier": 100, "unit": "%"},
        ]
        expected_rows = [(staged_row(1, {"municipio": "3509502", "ano": "2023", "estoque": "20", "admissoes": "4"}), {"reference_year": "2023"})]
        payload = {"import_id": "00000000-0000-0000-0000-000000000001", "status": "approved", "approved_value_count": 2, "indicators": [{"indicator_id": "employment", "approved_rows": 1}, {"indicator_id": "rate", "approved_rows": 1}]}

        with patch.object(main, "ensure_municipal_catalog_registered"), patch.object(main, "fetch_rows_for_municipality_resolution", return_value=[expected_rows[0][0]]), patch.object(main, "ibge_municipality_catalog", return_value=[{"ibge_code": "3509502"}]), patch.object(main, "upsert_staged_rows") as upsert_rows, patch.object(main.httpx, "get", return_value=successful_response(indicators)), patch.object(main.httpx, "post", return_value=successful_response(payload)) as post_request:
            response = TestClient(main.app).post("/imports/00000000-0000-0000-0000-000000000001/approve-municipal-batch", json={"municipality_field": "municipio", "period": {"mode": "year_column", "year_field": "ano"}, "mappings": [{"indicator_id": "employment", "value_field": "estoque", "unit": "pessoas"}, {"indicator_id": "rate", "numerator_field": "admissoes", "denominator_field": "estoque", "unit": "%"}]})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["approved_value_count"], 2)
        self.assertEqual([result["approved_rows"] for result in response.json()["indicator_results"]], [1, 1])
        upsert_rows.assert_called_once()
        self.assertEqual(post_request.call_count, 1)
        self.assertEqual(post_request.call_args.kwargs["json"]["selected_mappings"][1]["prepared_field"], "decsys_value__taxa_admissao")


def successful_response(response_json):
    class Response:
        is_success = True
        status_code = 200

        def json(self):
            return response_json

    return Response()


if __name__ == "__main__":
    unittest.main()
