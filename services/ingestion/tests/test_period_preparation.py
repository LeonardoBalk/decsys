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


class PeriodParsingTests(unittest.TestCase):
    def test_dates_in_common_brazilian_formats(self):
        cases = {
            "2024-03-01": (2024, 3), "2024-03-01T00:00:00": (2024, 3), "15/07/2023": (2023, 7), "03/2024": (2024, 3),
            "jan/2024": (2024, 1), "Março de 2024": (2024, 3), "set-24": (2024, 9), "202407": (2024, 7), "2024": (2024, None),
        }
        for date_text, expected in cases.items():
            with self.subTest(date_text=date_text):
                self.assertEqual(main.parse_date_period(date_text), expected)
        for invalid_text in ("abc", "2024-13-01", "", None):
            with self.subTest(invalid_text=invalid_text):
                self.assertIsNone(main.parse_date_period(invalid_text))

    def test_months_accept_numbers_and_portuguese_names(self):
        self.assertEqual([main.parse_month(value) for value in ("1", "12", 3.0, "Jan", "março", "fev.", "13", "x")], [1, 12, 3, 1, 3, 2, None, None])

    def test_years_accept_spreadsheet_floats(self):
        self.assertEqual([main.parse_year(value) for value in ("2023", "2023.0", 2021, "23", "1800")], [2023, 2023, 2021, None, None])

    def test_values_accept_percentages_and_brazilian_formats(self):
        cases = {"12,5%": "12.5", "1.234,56": "1234.56", "1,234.5": "1234.5", " 7 ": "7", 1e-05: "0.00001", 2.5: "2.5", 3: "3", "-0,5": "-0.5"}
        for original_value, expected in cases.items():
            with self.subTest(original_value=original_value):
                self.assertEqual(main.parse_numeric_value(original_value), expected)
        for invalid_value in ("abc", "", None, True, "1,2,3"):
            with self.subTest(invalid_value=invalid_value):
                self.assertIsNone(main.parse_numeric_value(invalid_value))

    def test_period_columns_are_recognized_by_title(self):
        self.assertEqual(main.monthly_period_from_column_name("jul_2024_saldo"), (2024, 7))
        self.assertIsNone(main.monthly_period_from_column_name("primar_2020"))
        self.assertEqual(main.annual_period_from_column_name("valor_2021"), 2021)
        self.assertEqual(main.annual_period_from_column_name("2019"), 2019)
        self.assertIsNone(main.annual_period_from_column_name("julho_2024"))


class PeriodPreparationTests(unittest.TestCase):
    def prepare(self, rows, **period_fields):
        period = main.PeriodSelection(**period_fields)
        main.validate_period_selection(period)
        prepared, period_problems, value_problems, _ = main.prepare_rows_for_approval(rows, period, "valor")
        return prepared, period_problems, value_problems

    def test_fixed_period_applies_to_every_row(self):
        prepared, period_problems, _ = self.prepare([staged_row(1, {"valor": "10"}), staged_row(2, {"valor": "12,5%"})], mode="fixed", granularity="month", fixed_year=2024, fixed_month=3)
        self.assertEqual([row for _, row in prepared], [
            {"reference_year": "2024", "reference_period": "2024-03-01", "value": "10"},
            {"reference_year": "2024", "reference_period": "2024-03-01", "value": "12.5"},
        ])
        self.assertEqual(period_problems, [])

    def test_date_column_can_be_read_as_annual_or_monthly(self):
        rows = [staged_row(1, {"data": "2024-03-01", "valor": 1})]
        monthly, _, _ = self.prepare(rows, mode="date_column", granularity="month", date_field="data")
        annual, _, _ = self.prepare(rows, mode="date_column", granularity="year", date_field="data")
        self.assertEqual(monthly[0][1]["reference_period"], "2024-03-01")
        self.assertEqual(annual[0][1], {"reference_year": "2024", "value": "1"})

    def test_month_and_year_columns_combine_into_a_monthly_period(self):
        prepared, problems, _ = self.prepare([staged_row(1, {"mes": "fev", "ano": "2023", "valor": 1}), staged_row(2, {"mes": "", "ano": "2023", "valor": 1})], mode="month_year_columns", year_field="ano", month_field="mes")
        self.assertEqual(prepared[0][1]["reference_period"], "2023-02-01")
        self.assertEqual(problems, [{"row_number": 2, "value": "/2023"}])

    def test_year_column_removes_stale_monthly_periods_and_keeps_other_prepared_fields(self):
        prepared, _, _ = self.prepare([staged_row(1, {"ano": 2022, "valor": 5}, {"reference_period": "2021-05-01", "municipality_ibge_code": "3550308"})], mode="year_column", year_field="ano")
        self.assertEqual(prepared[0][1], {"municipality_ibge_code": "3550308", "reference_year": "2022", "value": "5"})

    def test_prepared_mode_keeps_the_transformed_period(self):
        prepared, _, _, _ = main.prepare_rows_for_approval([staged_row(1, {}, {"reference_year": "2024", "reference_period": "2024-07-01", "value": "8"})], main.PeriodSelection(mode="prepared"), "value")
        self.assertEqual(prepared[0][1], {"reference_year": "2024", "reference_period": "2024-07-01", "value": "8"})

    def test_values_that_are_not_numbers_are_reported(self):
        _, _, value_problems = self.prepare([staged_row(4, {"valor": "sigiloso"})], mode="fixed", fixed_year=2024)
        self.assertEqual(value_problems, [{"row_number": 4, "value": "sigiloso"}])

    def test_incomplete_period_choices_are_rejected(self):
        for period_fields in ({"mode": "fixed"}, {"mode": "fixed", "fixed_year": 1800}, {"mode": "fixed", "fixed_year": 2024, "granularity": "month"}, {"mode": "date_column"}, {"mode": "month_year_columns", "year_field": "ano"}):
            with self.subTest(period_fields=period_fields):
                with self.assertRaises(HTTPException):
                    main.validate_period_selection(main.PeriodSelection(**period_fields))


class WidePeriodTransformTests(unittest.TestCase):
    @patch("services.ingestion.app.main.upsert_staged_rows")
    @patch("services.ingestion.app.main.fetch_rows_for_municipality_resolution")
    def test_annual_columns_keep_codes_confirmed_in_the_ibge_lookup(self, fetch_rows, upsert_rows):
        fetch_rows.return_value = [
            staged_row(1, {"municipio": "Campinas (SP)", "valor_2021": "1.234,5"}, {"municipality_ibge_code": "3509502", "municipality_code_source": "ibge_lookup"}),
            staged_row(2, {"municipio": "Sem código", "valor_2021": "3"}),
        ]

        result = main.normalize_wide_period_import("import-id", main.WideMunicipalTransform(municipality_field="municipality_ibge_code", value_field="valor_2021", sheet_name="Dados"))

        saved_rows = [normalized_row for _, normalized_row in upsert_rows.call_args.args[2]]
        self.assertEqual(saved_rows[0], {"municipality_ibge_code": "3509502", "municipality_code_source": "ibge_lookup", "reference_year": "2021", "value": "1234.5", "source_measure": "valor_2021"})
        self.assertEqual(saved_rows[1], {})
        self.assertEqual((result["granularity"], result["transformed_rows"], result["skipped_rows"]), ("year", 1, 1))

    @patch("services.ingestion.app.main.upsert_staged_rows")
    @patch("services.ingestion.app.main.fetch_rows_for_municipality_resolution")
    def test_monthly_columns_set_the_reference_month(self, fetch_rows, upsert_rows):
        fetch_rows.return_value = [staged_row(1, {"cod": "3550308", "julho_2026_saldos": 7})]

        result = main.normalize_wide_period_import("import-id", main.WideMunicipalTransform(municipality_field="cod", value_field="julho_2026_saldos"))

        self.assertEqual(upsert_rows.call_args.args[2][0][1]["reference_period"], "2026-07-01")
        self.assertEqual(result["reference_period"], "2026-07-01")

    def test_columns_without_a_period_are_rejected(self):
        with self.assertRaises(HTTPException):
            main.normalize_wide_period_import("import-id", main.WideMunicipalTransform(municipality_field="cod", value_field="valor"))


if __name__ == "__main__":
    unittest.main()
