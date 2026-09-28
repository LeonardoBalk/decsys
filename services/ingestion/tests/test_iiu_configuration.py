import unittest
from unittest.mock import patch

from services.ingestion.app import main


class SuccessfulResponse:
    is_success = True
    status_code = 200

    def __init__(self, response_payload):
        self.response_payload = response_payload

    def json(self):
        return self.response_payload


class IndicatorCalculationTests(unittest.TestCase):
    @patch("services.ingestion.app.main.ensure_municipal_catalog_registered")
    @patch("services.ingestion.app.main.get_indicator", return_value={"calculation_type": "ratio", "calculation_multiplier": 100})
    @patch("services.ingestion.app.main.supabase_headers", return_value={})
    @patch("services.ingestion.app.main.supabase_url", side_effect=lambda path: f"https://supabase.test{path}")
    @patch("services.ingestion.app.main.httpx.post")
    def test_ratio_values_are_prepared_before_municipal_approval(self, post_request, *_):
        post_request.side_effect = [SuccessfulResponse(6), SuccessfulResponse(4)]
        approval = main.MunicipalApproval(
            indicator_id="indicator-id",
            municipality_field="municipality_ibge_code",
            value_field="value",
            numerator_field="households_with_service",
            denominator_field="total_households",
            unit="%",
            sheet_name="Dados",
            period=main.PeriodSelection(mode="prepared"),
        )

        result = main.approve_municipal_import("import-id", approval)

        calculation_request, approval_request = post_request.call_args_list
        self.assertEqual(calculation_request.args[0], "https://supabase.test/rest/v1/rpc/prepare_municipal_import_calculation")
        self.assertEqual(calculation_request.kwargs["json"]["numerator_field"], "households_with_service")
        self.assertEqual(calculation_request.kwargs["json"]["denominator_field"], "total_households")
        self.assertEqual(calculation_request.kwargs["json"]["calculation_multiplier"], 100)
        self.assertEqual(approval_request.kwargs["json"]["value_field"], "value")
        self.assertEqual(result["approved_rows"], 4)

    @patch("services.ingestion.app.main.supabase_headers", return_value={})
    @patch("services.ingestion.app.main.supabase_url", side_effect=lambda path: f"https://supabase.test{path}")
    @patch("services.ingestion.app.main.httpx.post", return_value=SuccessfulResponse({"total_rows": 3, "valid_rows": 2, "invalid_rows": 1, "examples": []}))
    def test_direct_preview_passes_the_selected_source_column(self, post_request, *_):
        preview = main.MunicipalCalculationPreview(calculation_type="direct", direct_field="pib_per_capita", sheet_name="Tabela 1")

        result = main.preview_municipal_import_calculation("import-id", preview)

        self.assertEqual(post_request.call_args.args[0], "https://supabase.test/rest/v1/rpc/preview_municipal_import_calculation")
        self.assertEqual(post_request.call_args.kwargs["json"]["direct_field"], "pib_per_capita")
        self.assertEqual((result["valid_rows"], result["invalid_rows"]), (2, 1))


if __name__ == "__main__":
    unittest.main()
