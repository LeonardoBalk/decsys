import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from services.ingestion.app import main


def page(rows, content_range="0-0/0"):
    response = Mock()
    response.is_success = True
    response.status_code = 200
    response.headers = {"content-range": content_range}
    response.json.return_value = rows
    return response


@patch.dict("os.environ", {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"})
class DashboardValuesFilterTests(unittest.TestCase):
    def values_query(self, **filters):
        with patch.object(main.httpx, "get", return_value=page([])) as get_request:
            main.list_dashboard_values(**filters)
        return get_request.call_args_list[0].kwargs["params"]

    def test_without_filters_the_query_keeps_the_original_shape(self):
        params = self.values_query()
        self.assertEqual(set(params) - {"select"}, {"order", "limit", "offset"})
        self.assertEqual((params["limit"], params["offset"], params["order"]), ("200", "0", "reference_period.desc,id"))

    def test_existing_indicator_and_dataset_filters_still_work(self):
        params = self.values_query(indicator_code="eco01_pib", dataset_id="abc", limit=50, offset=100)
        self.assertEqual((params["indicator_code"], params["dataset_id"], params["limit"], params["offset"]), ("eq.eco01_pib", "eq.abc", "50", "100"))
        self.assertNotIn("and", params)
        self.assertNotIn("or", params)

    def test_municipality_filter_uses_the_ibge_code_dimension(self):
        self.assertEqual(self.values_query(municipality_code=" 3550308 ")["dimensions->>municipality_ibge_code"], "eq.3550308")

    def test_municipality_code_must_have_seven_digits(self):
        with self.assertRaises(HTTPException) as caught:
            main.list_dashboard_values(municipality_code="355")
        self.assertEqual(caught.exception.status_code, 422)

    def test_dimension_accepts_the_prefix_or_the_name_with_or_without_accents(self):
        for dimension, prefix in [("eco", "eco"), ("PES", "pes"), ("Economia", "eco"), ("governança", "gov"), ("Governanca", "gov"), ("Qualidade de Vida", "qvi"), ("Infraestrutura Digital e Dados", "idd"), ("Mobilidade", "mob"), ("ambiente", "amb")]:
            self.assertEqual(self.values_query(dimension=dimension)["and"], f"(indicator_code.like.{prefix}*)", dimension)

    def test_unknown_dimension_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            main.list_dashboard_values(dimension="Esportes")
        self.assertEqual(caught.exception.status_code, 422)

    def test_period_bounds_expand_years_and_months_to_the_whole_period(self):
        self.assertEqual(self.values_query(period_from="2020", period_to="2023")["and"], "(reference_period.gte.2020-01-01,reference_period.lte.2023-12-31)")
        self.assertEqual(self.values_query(period_from="2021-03", period_to="2024-02")["and"], "(reference_period.gte.2021-03-01,reference_period.lte.2024-02-29)")
        self.assertEqual(self.values_query(period_to="2023-02")["and"], "(reference_period.lte.2023-02-28)")
        self.assertEqual(self.values_query(period_from="2022-05-17")["and"], "(reference_period.gte.2022-05-17)")

    def test_filters_on_the_same_column_are_combined_in_one_and_group(self):
        params = self.values_query(indicator_code="eco01_x", dimension="eco", period_from="2020", period_to="2022")
        self.assertEqual(params["indicator_code"], "eq.eco01_x")
        self.assertEqual(params["and"], "(indicator_code.like.eco*,reference_period.gte.2020-01-01,reference_period.lte.2022-12-31)")

    def test_invalid_or_inverted_periods_are_refused(self):
        for bad_period in ("20", "2020-13", "2021-02-30", "ontem", "0000"):
            with self.assertRaises(HTTPException, msg=bad_period) as caught:
                main.list_dashboard_values(period_from=bad_period)
            self.assertEqual(caught.exception.status_code, 422)
        with self.assertRaises(HTTPException) as caught:
            main.list_dashboard_values(period_from="2024", period_to="2020")
        self.assertEqual(caught.exception.status_code, 422)

    def test_search_matches_the_indicator_code_or_name(self):
        self.assertEqual(self.values_query(search="pib per capita")["or"], "(indicator_code.ilike.*pib per capita*,indicator_name.ilike.*pib per capita*)")

    def test_search_drops_characters_that_would_break_the_postgrest_filter(self):
        self.assertEqual(self.values_query(search='a,b) or (c*"d\\')["or"], "(indicator_code.ilike.*a b  or  c  d*,indicator_name.ilike.*a b  or  c  d*)")
        self.assertNotIn("or", self.values_query(search=" ,() "))
        self.assertNotIn("or", self.values_query(search="   "))

    def test_every_filter_together_through_the_http_route(self):
        values = [{"id": "1", "indicator_code": "eco01_x", "dimensions": {"municipality_ibge_code": "3550308"}}]
        names = [{"ibge_code": "3550308", "name": "São Paulo", "state": "SP"}]
        with patch.object(main.httpx, "get", side_effect=[page(values, "0-0/37"), page(names)]) as get_request:
            body = TestClient(main.app).get("/dashboard-values", params={"municipality_code": "3550308", "dimension": "Economia", "period_from": "2020", "period_to": "2023", "search": "pib", "limit": 25}).json()
        params = get_request.call_args_list[0].kwargs["params"]
        self.assertEqual((params["dimensions->>municipality_ibge_code"], params["limit"]), ("eq.3550308", "25"))
        self.assertEqual(params["and"], "(indicator_code.like.eco*,reference_period.gte.2020-01-01,reference_period.lte.2023-12-31)")
        self.assertEqual((body["total"], body["items"][0]["municipality_name"]), (37, "São Paulo (SP)"))

    def test_invalid_filter_through_the_http_route_returns_422_with_a_message(self):
        reply = TestClient(main.app).get("/dashboard-values", params={"period_from": "ontem"})
        self.assertEqual(reply.status_code, 422)
        self.assertIn("AAAA", reply.json()["detail"])


if __name__ == "__main__":
    unittest.main()
