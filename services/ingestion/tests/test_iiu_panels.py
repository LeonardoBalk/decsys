import re
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from services.ingestion.app import main, routes_iiu_panels

DIMENSIONS = [
    {"code": "eco", "name": "Economia", "color": "#f59e0b", "display_order": 1, "weight": 60},
    {"code": "pes", "name": "Pessoas", "color": "#ec4899", "display_order": 2, "weight": 40},
]


def indicator(code, dimension, direction="direct", checklist_max=None):
    return {"code": code, "name": code.upper(), "unit": "%", "formula": "f" * 40, "iiu_dimension_code": dimension, "iiu_type": "t", "source_description": "s" * 40, "score_direction": direction, "checklist_max": checklist_max, "display_order": 1}


INDICATORS = [
    indicator("eco01_a", "eco"),
    indicator("eco02_b", "eco", "inverse"),
    indicator("pes01_c", "pes", "checklist", 5),
    indicator("pes02_sem_faixa", "pes"),
]
BENCHMARKS = [
    {"indicator_code": "eco01_a", "minimum_value": 0, "maximum_value": 100},
    {"indicator_code": "eco02_b", "minimum_value": 0, "maximum_value": 100},
]
MUNICIPALITIES = [
    {"ibge_code": "1111111", "name": "São Paulo", "state": "SP"},
    {"ibge_code": "2222222", "name": "Belo Horizonte", "state": "MG"},
    {"ibge_code": "3333333", "name": "Campinas", "state": "SP"},
    {"ibge_code": "4444444", "name": "Santos", "state": "SP"},
]


def value(code, indicator_code, amount, period="2024-01-01", **extra):
    return {"id": f"{code}-{indicator_code}-{period}", "indicator_code": indicator_code, "indicator_name": indicator_code.upper(), "value": amount, "reference_period": period, "unit": "%", "source_name": "Fonte", "import_title": "Importação", "dimensions": {"municipality_ibge_code": code}, **extra}


VALUES = [
    value("1111111", "eco01_a", 50), value("1111111", "eco02_b", 20), value("1111111", "pes01_c", 4),
    value("2222222", "eco01_a", 90),
    value("3333333", "pes02_sem_faixa", 10),
    value("4444444", "eco01_a", 10, "2020-01-01"), value("4444444", "eco01_a", 30, "2024-01-01"),
]


def response(rows, headers=None):
    reply = Mock()
    reply.is_success = True
    reply.status_code = 200
    reply.headers = headers or {}
    reply.json.return_value = rows
    return reply


def postgrest_stub(tables):
    def fake_get(url, params=None, **_):
        params = params or {}
        rows = list(tables[url.rsplit("/", 1)[1]])
        for column, condition in params.items():
            if column in ("select", "order", "limit", "offset", "city_profile"):
                continue
            if condition.startswith("eq."):
                rows = [row for row in rows if str((row.get("dimensions") or {}).get(column.split("->>")[1]) if "->>" in column else row.get(column)) == condition[3:]]
            elif condition.startswith("in.("):
                allowed = set(condition[4:-1].split(","))
                rows = [row for row in rows if str(row.get(column)) in allowed]
        order = params.get("order", "")
        if order.startswith("reference_period.desc"):
            rows.sort(key=lambda row: row["reference_period"], reverse=True)
        elif order.startswith("reference_period.asc"):
            rows.sort(key=lambda row: row["reference_period"])
        offset, limit = int(params.get("offset", 0)), int(params.get("limit", len(rows)))
        return response(rows[offset:offset + limit])
    return fake_get


def standard_tables(**overrides):
    return {"iiu_indicator_catalog": INDICATORS, "iiu_dimension_catalog": DIMENSIONS, "iiu_indicator_benchmark_catalog": BENCHMARKS, "dashboard_values": VALUES, "iiu_municipalities": MUNICIPALITIES, **overrides}


@patch.dict("os.environ", {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"})
class IiuRankingTests(unittest.TestCase):
    def setUp(self):
        routes_iiu_panels.clear_ranking_cache()
        self.client = TestClient(main.app)

    def ranking(self, tables=None, **params):
        with patch.object(main.httpx, "get", side_effect=postgrest_stub(tables or standard_tables())) as get_request:
            reply = self.client.get("/iiu-ranking", params=params)
        self.get_request = get_request
        return reply

    def test_municipalities_are_ranked_by_overall_score_renormalising_the_weights(self):
        body = self.ranking(city_profile="medio").json()
        self.assertEqual([(item["rank"], item["municipality_ibge_code"]) for item in body["items"]], [(1, "2222222"), (2, "1111111"), (3, "4444444")])
        scores = {item["municipality_ibge_code"]: item["overall_score"] for item in body["items"]}
        self.assertAlmostEqual(scores["2222222"], 90.0)
        self.assertAlmostEqual(scores["1111111"], 71.0)
        self.assertAlmostEqual(scores["4444444"], 30.0)
        self.assertEqual(body["scored_municipalities"], 3)

    def test_municipalities_without_a_scored_dimension_are_left_out(self):
        codes = [item["municipality_ibge_code"] for item in self.ranking().json()["items"]]
        self.assertNotIn("3333333", codes)

    def test_only_the_latest_value_of_each_indicator_counts(self):
        item = next(item for item in self.ranking().json()["items"] if item["municipality_ibge_code"] == "4444444")
        self.assertAlmostEqual(item["dimension_scores"]["eco"], 30.0)
        self.assertEqual(item["observed_indicators"], 1)

    def test_item_carries_name_state_maturity_and_dimension_scores(self):
        item = self.ranking().json()["items"][1]
        self.assertEqual((item["name"], item["state"], item["maturity"]), ("São Paulo", "SP", "Nível 4 - Gerenciado"))
        self.assertAlmostEqual(item["dimension_scores"]["eco"], 65.0)
        self.assertAlmostEqual(item["dimension_scores"]["pes"], 80.0)
        self.assertEqual((item["scored_indicators"], item["observed_indicators"]), (3, 3))

    def test_ranking_matches_the_single_municipality_diagnosis(self):
        ranked = {item["municipality_ibge_code"]: item for item in self.ranking().json()["items"]}
        with patch.object(main.httpx, "get", side_effect=postgrest_stub(standard_tables())):
            for municipality_code in ("1111111", "2222222", "4444444"):
                diagnosis = main.get_iiu_dashboard(municipality_code, "medio")
                self.assertAlmostEqual(ranked[municipality_code]["overall_score"], diagnosis["overall_score"])
                self.assertEqual(ranked[municipality_code]["maturity"], diagnosis["maturity"])
                self.assertEqual(ranked[municipality_code]["scored_indicators"], diagnosis["scored_indicators"])
                for dimension in diagnosis["dimensions"]:
                    expected = dimension["score"]
                    actual = ranked[municipality_code]["dimension_scores"][dimension["code"]]
                    self.assertEqual(actual is None, expected is None)
                    if expected is not None:
                        self.assertAlmostEqual(actual, expected)

    def test_dimension_filter_ranks_by_the_dimension_and_drops_municipalities_without_it(self):
        body = self.ranking(dimension="pes").json()
        self.assertEqual([(item["rank"], item["municipality_ibge_code"], item["score"]) for item in body["items"]], [(1, "1111111", 80.0)])
        economy = self.ranking(dimension="eco").json()
        self.assertEqual([item["municipality_ibge_code"] for item in economy["items"]], ["2222222", "1111111", "4444444"])
        self.assertEqual(economy["items"][0]["score"], 90.0)

    def test_search_ignores_accents_and_case_and_keeps_the_real_rank(self):
        body = self.ranking(search="sao PAULO").json()
        self.assertEqual([(item["rank"], item["name"]) for item in body["items"]], [(2, "São Paulo")])
        self.assertEqual((body["total"], body["scored_municipalities"]), (1, 3))
        self.assertEqual([item["name"] for item in self.ranking(search="2222222").json()["items"]], ["Belo Horizonte"])

    def test_sorting_by_name_and_by_dimension_does_not_change_the_rank(self):
        by_name = self.ranking(sort="name").json()["items"]
        self.assertEqual([item["name"] for item in by_name], ["Belo Horizonte", "Santos", "São Paulo"])
        self.assertEqual([item["rank"] for item in by_name], [1, 3, 2])
        by_pes = self.ranking(sort="pes", direction="desc").json()["items"]
        self.assertEqual(by_pes[0]["municipality_ibge_code"], "1111111")
        self.assertTrue(all(item["dimension_scores"]["pes"] is None for item in by_pes[1:]))
        ascending = self.ranking(direction="asc").json()["items"]
        self.assertEqual([item["rank"] for item in ascending], [3, 2, 1])

    def test_pagination_returns_a_window_and_the_total(self):
        body = self.ranking(limit=2, offset=1).json()
        self.assertEqual((body["total"], len(body["items"]), body["offset"]), (3, 2, 1))
        self.assertEqual([item["rank"] for item in body["items"]], [2, 3])

    def test_equal_scores_share_the_same_position(self):
        self.assertEqual(routes_iiu_panels.competition_ranks([90.0, 80.0, 80.0, 70.0]), [1, 2, 2, 4])

    def test_invalid_parameters_are_refused(self):
        self.assertEqual(self.ranking(city_profile="enorme").status_code, 422)
        self.assertEqual(self.ranking(dimension="xyz").status_code, 422)
        self.assertEqual(self.ranking(sort="inexistente").status_code, 422)
        self.assertEqual(self.ranking(direction="sideways").status_code, 422)

    def test_the_result_is_cached_per_profile_and_refresh_recalculates(self):
        self.ranking(city_profile="medio")
        first_call_count = self.get_request.call_count
        self.assertGreater(first_call_count, 0)
        cached = self.ranking(city_profile="medio").json()
        self.assertEqual(self.get_request.call_count, 0)
        self.assertTrue(cached["cached"])
        other_profile = self.ranking(city_profile="grande").json()
        self.assertGreater(self.get_request.call_count, 0)
        self.assertFalse(other_profile["cached"])
        refreshed = self.ranking(city_profile="medio", refresh="true").json()
        self.assertGreater(self.get_request.call_count, 0)
        self.assertFalse(refreshed["cached"])

    def test_the_cache_expires_after_five_minutes(self):
        def at(seconds):
            return patch.object(routes_iiu_panels, "time", Mock(monotonic=Mock(return_value=seconds)))

        with at(1000.0):
            self.ranking()
        with at(1000.0 + routes_iiu_panels.ranking_cache_seconds - 1):
            self.assertTrue(self.ranking().json()["cached"])
        with at(1000.0 + routes_iiu_panels.ranking_cache_seconds + 1):
            self.assertFalse(self.ranking().json()["cached"])

    def test_values_are_read_in_pages_of_one_thousand_rows(self):
        many_values = [value(f"{code:07d}", "eco01_a", float(code % 100)) for code in range(1, 2501)]
        names = [{"ibge_code": f"{code:07d}", "name": f"Cidade {code}", "state": "SP"} for code in range(1, 2501)]
        body = self.ranking(standard_tables(dashboard_values=many_values, iiu_municipalities=names), limit=1000).json()
        self.assertEqual(body["scored_municipalities"], 2500)
        value_requests = [call.kwargs["params"] for call in self.get_request.call_args_list if call.args[0].endswith("/dashboard_values")]
        self.assertEqual([request["offset"] for request in value_requests], [0, 1000, 2000])
        self.assertTrue(all(request["limit"] == 1000 for request in value_requests))
        self.assertFalse(body["truncated"])

    def test_only_indicators_that_can_score_are_requested(self):
        self.ranking()
        value_requests = [call.kwargs["params"] for call in self.get_request.call_args_list if call.args[0].endswith("/dashboard_values")]
        requested = set(re.findall(r"[a-z0-9_]+", value_requests[0]["indicator_code"].removeprefix("in.")))
        self.assertEqual(requested, {"eco01_a", "eco02_b", "pes01_c"})

    def test_a_municipality_missing_from_the_catalog_falls_back_to_its_code(self):
        body = self.ranking(standard_tables(iiu_municipalities=[])).json()
        self.assertEqual(body["items"][0]["name"], "2222222")

    def test_an_upstream_failure_is_reported_instead_of_returning_a_partial_ranking(self):
        failing = Mock(is_success=False, status_code=500)
        failing.json.return_value = {"message": "boom"}
        with patch.object(main.httpx, "get", return_value=failing):
            self.assertEqual(self.client.get("/iiu-ranking").status_code, 502)


@patch.dict("os.environ", {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"})
class IiuCompareTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def compare(self, codes, **params):
        with patch.object(main.httpx, "get", side_effect=postgrest_stub(standard_tables())):
            return self.client.get("/iiu-compare", params={"codes": codes, **params})

    def test_compares_municipalities_in_the_requested_order_with_their_names(self):
        body = self.compare("2222222,1111111").json()
        self.assertEqual([item["municipality_ibge_code"] for item in body["municipalities"]], ["2222222", "1111111"])
        self.assertEqual([item["name"] for item in body["municipalities"]], ["Belo Horizonte", "São Paulo"])
        self.assertAlmostEqual(body["municipalities"][0]["overall_score"], 90.0)
        self.assertAlmostEqual(body["municipalities"][1]["overall_score"], 71.0)
        self.assertEqual(body["city_profile"], "medio")

    def test_each_municipality_carries_dimension_and_indicator_values(self):
        sao_paulo = self.compare("1111111,2222222").json()["municipalities"][0]
        economy = next(dimension for dimension in sao_paulo["dimensions"] if dimension["code"] == "eco")
        first_indicator = economy["indicators"][0]
        self.assertEqual((first_indicator["code"], first_indicator["raw_value"], first_indicator["score"]), ("eco01_a", 50.0, 50.0))
        self.assertNotIn("formula", first_indicator)
        self.assertNotIn("source", first_indicator)

    def test_repeated_codes_count_once(self):
        self.assertEqual(self.compare("1111111,1111111").status_code, 422)
        self.assertEqual(len(self.compare("1111111, 2222222 ,1111111").json()["municipalities"]), 2)

    def test_between_two_and_four_municipalities_are_required(self):
        self.assertEqual(self.compare("1111111").status_code, 422)
        self.assertEqual(self.compare("1111111,2222222,3333333,4444444,5555555").status_code, 422)
        self.assertEqual(len(self.compare("1111111,2222222,3333333,4444444").json()["municipalities"]), 4)

    def test_codes_must_have_seven_digits_and_the_profile_must_exist(self):
        self.assertEqual(self.compare("1111111,abc").status_code, 422)
        self.assertEqual(self.compare("1111111,2222222", city_profile="enorme").status_code, 422)
        self.assertEqual(self.client.get("/iiu-compare").status_code, 422)


@patch.dict("os.environ", {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"})
class IiuTimeseriesTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.series = [value("1111111", "eco01_a", 40, "2022-01-01"), value("1111111", "eco01_a", 50, "2024-01-01"), value("1111111", "eco01_a", 45, "2023-01-01", period_granularity="year"), value("1111111", "eco02_b", 20, "2024-01-01"), value("2222222", "eco01_a", 90, "2024-01-01")]

    def timeseries(self, code, **params):
        with patch.object(main.httpx, "get", side_effect=postgrest_stub(standard_tables(dashboard_values=self.series))):
            return self.client.get(f"/iiu-timeseries/{code}", params=params)

    def test_series_is_returned_in_chronological_order_for_the_municipality_and_indicator(self):
        body = self.timeseries("1111111", indicator_code="eco01_a").json()
        self.assertEqual([point["reference_period"] for point in body["points"]], ["2022-01-01", "2023-01-01", "2024-01-01"])
        self.assertEqual([point["value"] for point in body["points"]], [40, 45, 50])
        self.assertEqual((body["municipality_name"], body["state"]), ("São Paulo", "SP"))
        self.assertEqual(body["indicator"], {"code": "eco01_a", "name": "ECO01_A", "unit": "%"})

    def test_other_municipalities_are_not_mixed_in(self):
        body = self.timeseries("2222222", indicator_code="eco01_a").json()
        self.assertEqual([point["value"] for point in body["points"]], [90])

    def test_an_indicator_without_values_returns_an_empty_series(self):
        body = self.timeseries("3333333", indicator_code="eco01_a").json()
        self.assertEqual((body["points"], body["indicator"]), ([], None))

    def test_without_an_indicator_it_lists_those_the_municipality_has(self):
        body = self.timeseries("1111111").json()
        summaries = {summary["code"]: summary for summary in body["indicators"]}
        self.assertEqual(set(summaries), {"eco01_a", "eco02_b"})
        self.assertEqual((summaries["eco01_a"]["observations"], summaries["eco01_a"]["first_period"], summaries["eco01_a"]["last_period"]), (3, "2022-01-01", "2024-01-01"))

    def test_unknown_municipality_and_malformed_code_are_refused(self):
        self.assertEqual(self.timeseries("9999999", indicator_code="eco01_a").status_code, 404)
        self.assertEqual(self.timeseries("abc", indicator_code="eco01_a").status_code, 422)

    def test_series_still_loads_before_the_granularity_migration(self):
        missing_column = Mock(is_success=False, status_code=400)
        missing_column.json.return_value = {"message": "column dashboard_values.period_granularity does not exist"}
        healthy = postgrest_stub(standard_tables(dashboard_values=self.series))

        def fake_get(url, params=None, **kwargs):
            if url.endswith("/dashboard_values") and "period_granularity" in params["select"]:
                return missing_column
            return healthy(url, params=params, **kwargs)

        with patch.object(main.httpx, "get", side_effect=fake_get):
            body = self.client.get("/iiu-timeseries/1111111", params={"indicator_code": "eco01_a"}).json()
        self.assertEqual(len(body["points"]), 3)


if __name__ == "__main__":
    unittest.main()
