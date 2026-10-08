import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from services.ingestion.app import main


def page(rows):
    response = Mock()
    response.is_success = True
    response.json.return_value = rows
    return response


def municipal_row(code, value, period="2025-01-01"):
    return {"value": value, "reference_period": period, "dimensions": {"municipality_ibge_code": f"{code:07d}"}}


@patch.dict("os.environ", {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"})
class BenchmarkSuggestionTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def test_percentile_interpolates_between_neighbours(self):
        values = [0.0, 10.0, 20.0, 30.0, 40.0]
        self.assertEqual(main.percentile(values, 0.0), 0.0)
        self.assertEqual(main.percentile(values, 0.5), 20.0)
        self.assertEqual(main.percentile(values, 0.1), 4.0)
        self.assertEqual(main.percentile(values, 1.0), 40.0)

    def test_only_the_latest_value_of_each_municipality_counts(self):
        rows = [municipal_row(1, 10, "2021-01-01"), municipal_row(1, 99, "2025-01-01"), municipal_row(2, 5, "2025-01-01"), {"value": None, "reference_period": "2025-01-01", "dimensions": {"municipality_ibge_code": "0000003"}}]
        latest = {row["dimensions"]["municipality_ibge_code"]: row["value"] for row in main.latest_value_per_municipality(rows)}
        self.assertEqual(latest, {"0000001": 99, "0000002": 5})

    def test_suggestion_uses_p10_and_p90_of_the_latest_values(self):
        rows = [municipal_row(code, float(code)) for code in range(1, 101)]  # 1..100
        with patch.object(main.httpx, "get", return_value=page(rows)):
            body = self.client.get("/iiu-configuration/benchmark-suggestion", params={"indicator_code": "pes01"}).json()
        self.assertEqual(body["sample_size"], 100)
        self.assertAlmostEqual(body["minimum_value"], 10.9, places=3)
        self.assertAlmostEqual(body["maximum_value"], 90.1, places=3)

    def test_small_samples_are_refused(self):
        with patch.object(main.httpx, "get", return_value=page([municipal_row(code, float(code)) for code in range(1, 6)])):
            response = self.client.get("/iiu-configuration/benchmark-suggestion", params={"indicator_code": "eco01"})
        self.assertEqual(response.status_code, 422)
        self.assertIn("pelo menos 30", response.json()["detail"])

    def test_constant_values_are_refused(self):
        with patch.object(main.httpx, "get", return_value=page([municipal_row(code, 7.0) for code in range(1, 61)])):
            self.assertEqual(self.client.get("/iiu-configuration/benchmark-suggestion", params={"indicator_code": "x"}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
