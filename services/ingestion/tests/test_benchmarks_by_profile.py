import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from services.ingestion.app import benchmarks, main, population


def municipal(code, value, period="2025-01-01"):
    return {"value": value, "reference_period": period, "dimensions": {"municipality_ibge_code": f"{code:07d}"}}


def ok(payload):
    response = Mock()
    response.is_success = True
    response.status_code = 200
    response.json.return_value = payload
    return response


class CityProfileTests(unittest.TestCase):
    def test_limits_follow_the_labels_used_in_the_screens(self):
        self.assertEqual([population.city_profile_for_population(value) for value in (1, 50_000, 50_001, 300_000, 300_001, 1_000_000, 1_000_001, 12_000_000)], ["pequeno", "pequeno", "medio", "medio", "grande", "grande", "metropole", "metropole"])

    def test_latest_population_steps_back_until_a_year_exists_and_caches_it(self):
        population.latest_population_cache.update({"expires_at": 0.0, "year": None, "by_code": {}})

        def fake(year):
            if year >= 2025:
                raise HTTPException(422, "sem dado")
            return {"3509502": 1_100_000}

        with patch.object(population, "population_by_municipality", side_effect=fake) as lookup:
            self.assertEqual(population.latest_population(today_year=2026), (2024, {"3509502": 1_100_000}))
            population.latest_population(today_year=2026)
        self.assertEqual([call.args[0] for call in lookup.call_args_list], [2026, 2025, 2024])
        population.latest_population_cache.update({"expires_at": 0.0, "year": None, "by_code": {}})

    def test_non_422_errors_are_not_swallowed(self):
        population.latest_population_cache.update({"expires_at": 0.0, "year": None, "by_code": {}})
        with patch.object(population, "population_by_municipality", side_effect=HTTPException(502, "ibge fora do ar")):
            with self.assertRaises(HTTPException) as error:
                population.latest_population(today_year=2026)
        self.assertEqual(error.exception.status_code, 502)


class SuggestionsByProfileTests(unittest.TestCase):
    def setUp(self):
        # 40 municípios pequenos (valor 1..40), 35 médios (101..135), 3 metrópoles
        self.rows = [municipal(code, float(code)) for code in range(1, 41)] + [municipal(1000 + code, 100.0 + code) for code in range(1, 36)] + [municipal(5000 + code, 500.0 + code) for code in range(1, 4)]
        self.population = {**{f"{code:07d}": 10_000 for code in range(1, 41)}, **{f"{1000 + code:07d}": 100_000 for code in range(1, 36)}, **{f"{5000 + code:07d}": 5_000_000 for code in range(1, 4)}}

    def test_each_profile_gets_its_own_percentiles(self):
        result = benchmarks.suggestions_for_rows(self.rows, self.population)
        self.assertEqual(result["municipalities"], 78)
        self.assertEqual(result["profiles"]["pequeno"]["sample_size"], 40)
        self.assertLess(result["profiles"]["pequeno"]["maximum_value"], 40)
        self.assertGreater(result["profiles"]["medio"]["minimum_value"], 100)
        self.assertIsNone(result["profiles"]["grande"])
        self.assertIsNone(result["profiles"]["metropole"], "3 municípios não bastam nem para o mínimo de 10")

    def test_without_population_only_the_overall_range_exists(self):
        result = benchmarks.suggestions_for_rows(self.rows, None)
        self.assertIsNotNone(result["overall"])
        self.assertTrue(all(value is None for value in result["profiles"].values()))

    def test_small_samples_for_metropolis_are_allowed_down_to_ten_and_flagged_as_low_reliability(self):
        rows = [municipal(9000 + code, float(code * 3)) for code in range(1, 13)]
        by_code = {f"{9000 + code:07d}": 3_000_000 for code in range(1, 13)}
        result = benchmarks.suggestions_for_rows(rows, by_code)
        self.assertEqual((result["profiles"]["metropole"]["sample_size"], result["profiles"]["metropole"]["reliability"]), (12, "baixa"))

    def test_endpoint_returns_overall_and_profiles_or_422_when_there_is_no_sample(self):
        with patch.object(benchmarks, "fetch_indicator_values", return_value=self.rows), patch.object(population, "latest_population", return_value=(2026, self.population)):
            body = TestClient(main.app).get("/iiu-configuration/benchmark-suggestion/by-profile", params={"indicator_code": "x"}).json()
        self.assertEqual(body["population_year"], 2026)
        self.assertIsNotNone(body["profiles"]["pequeno"])
        with patch.object(benchmarks, "fetch_indicator_values", return_value=self.rows[:5]), patch.object(population, "latest_population", side_effect=HTTPException(503, "x")):
            response = TestClient(main.app).get("/iiu-configuration/benchmark-suggestion/by-profile", params={"indicator_code": "x"})
        self.assertEqual(response.status_code, 422)

    def test_municipality_profile_endpoint(self):
        with patch.object(population, "latest_population", return_value=(2026, {"3509502": 1_189_761, "1200013": 15_000})):
            big = TestClient(main.app).get("/iiu-municipality-profile/3509502").json()
            small = TestClient(main.app).get("/iiu-municipality-profile/1200013").json()
            missing = TestClient(main.app).get("/iiu-municipality-profile/9999999")
            invalid = TestClient(main.app).get("/iiu-municipality-profile/abc")
        self.assertEqual((big["city_profile"], big["population"], big["population_year"]), ("metropole", 1_189_761, 2026))
        self.assertEqual(small["city_profile"], "pequeno")
        self.assertEqual((missing.status_code, invalid.status_code), (404, 422))


class AutomaticBenchmarksTests(unittest.TestCase):
    def test_saves_per_profile_with_overall_fallback_and_skips_indicators_without_data(self):
        rows = [municipal(code, float(code)) for code in range(1, 41)]
        by_code = {f"{code:07d}": 10_000 for code in range(1, 41)}  # só porte pequeno
        catalog = [{"code": "pes01", "name": "PES01"}, {"code": "vazio", "name": "Vazio"}]

        def fake_values(code, only_probe=False):
            return (rows[:1] if only_probe else rows) if code == "pes01" else []

        with patch("services.ingestion.app.benchmarks.httpx.get", return_value=ok(catalog)), patch("services.ingestion.app.supabase_client.supabase_url", return_value="https://s.test"), patch("services.ingestion.app.supabase_client.supabase_headers", return_value={}), \
                patch.object(benchmarks, "fetch_indicator_values", side_effect=fake_values), patch.object(population, "latest_population", return_value=(2026, by_code)), patch.object(benchmarks, "update_iiu_indicator_benchmark") as save:
            result = benchmarks.run_automatic_benchmarks(benchmarks.AutomaticBenchmarks())
        self.assertEqual(save.call_count, 4)
        origins = {item["city_profile"]: item["origin"] for item in result["details"]}
        self.assertEqual(origins, {"pequeno": "porte", "medio": "geral", "grande": "geral", "metropole": "geral"})
        self.assertEqual(result["indicators_with_data"], 1)
        self.assertEqual(result["skipped"], 0)

    def test_without_enough_data_nothing_is_saved(self):
        rows = [municipal(code, float(code)) for code in range(1, 6)]
        with patch("services.ingestion.app.benchmarks.httpx.get", return_value=ok([{"code": "x", "name": "X"}])), patch("services.ingestion.app.supabase_client.supabase_url", return_value="https://s.test"), patch("services.ingestion.app.supabase_client.supabase_headers", return_value={}), \
                patch.object(benchmarks, "fetch_indicator_values", side_effect=lambda code, only_probe=False: rows[:1] if only_probe else rows), patch.object(population, "latest_population", side_effect=HTTPException(503, "x")), patch.object(benchmarks, "update_iiu_indicator_benchmark") as save:
            result = benchmarks.run_automatic_benchmarks(benchmarks.AutomaticBenchmarks(city_profiles=["medio"]))
        save.assert_not_called()
        self.assertEqual((result["saved"], result["skipped"]), (0, 1))

    def test_background_flag_starts_a_job(self):
        with patch.object(benchmarks, "run_automatic_benchmarks", return_value={"saved": 0}):
            response = TestClient(main.app).post("/iiu-configuration/benchmarks/auto?background=true", json={})
        self.assertEqual((response.status_code, response.json()["kind"]), (202, "benchmarks"))


if __name__ == "__main__":
    unittest.main()
