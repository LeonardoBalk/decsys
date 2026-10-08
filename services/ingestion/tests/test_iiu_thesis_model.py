import re
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from services.ingestion.app import main

MIGRATIONS = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
CATALOG_SQL = (MIGRATIONS / "0020_thesis_indicator_catalog.sql").read_text(encoding="utf-8")
MODEL_SQL = (MIGRATIONS / "0023_iiu_thesis_model.sql").read_text(encoding="utf-8")


def catalog_codes() -> set[str]:
    return set(re.findall(r"^  \('([a-z]{3}\d{2}_[a-z0-9_]+)', ", CATALOG_SQL, flags=re.MULTILINE))


def model_rows() -> list[tuple[str, str, str, str, str]]:
    return re.findall(r"^  \('([a-z]{3}\d{2}_[a-z0-9_]+)', '([a-z]{3})', '([^']*)', '(direct|inverse|checklist)', (null|\d+)\)", MODEL_SQL, flags=re.MULTILINE)


class ThesisModelMigrationTests(unittest.TestCase):
    def test_every_catalog_indicator_is_configured_exactly_once(self):
        codes = [row[0] for row in model_rows()]
        self.assertEqual(len(codes), 102)
        self.assertEqual(set(codes), catalog_codes())
        self.assertEqual(len(set(codes)), len(codes))

    def test_dimension_codes_match_the_indicator_prefix(self):
        for code, dimension, _, _, _ in model_rows():
            self.assertEqual(code[:3], dimension, code)

    def test_checklist_indicators_have_a_maximum_and_others_do_not(self):
        for code, _, _, direction, maximum in model_rows():
            self.assertEqual(direction == "checklist", maximum != "null", code)

    def test_default_weights_add_up_to_exactly_one_hundred(self):
        weight_block = MODEL_SQL.split("cross join (values", 1)[1].split(") as defaults", 1)[0]
        weights = [Decimal(value) for value in re.findall(r"'[a-z]{3}', ([\d.]+)\)", weight_block)]
        self.assertEqual(len(weights), 7)
        self.assertEqual(sum(weights), Decimal("100.00"))

    def test_legacy_model_is_snapshotted_before_anything_is_changed(self):
        self.assertLess(MODEL_SQL.index("insert into core.iiu_legacy_snapshot"), MODEL_SQL.index("update municipal.indicators"))
        self.assertLess(MODEL_SQL.index("insert into core.iiu_legacy_snapshot"), MODEL_SQL.index("delete from core.iiu_dimensions"))

    def test_demonstration_values_point_to_real_indicators(self):
        prefixes = {code.split("_", 1)[0] for code in catalog_codes()}
        self.assertTrue(set(main.iiu_demonstration_values) <= prefixes)


class DemonstrationDashboardTests(unittest.TestCase):
    def test_demo_scores_thesis_indicators_even_without_saved_benchmarks(self):
        indicator = lambda code, direction: {"code": code, "name": code, "unit": "x", "formula": "f", "iiu_dimension_code": "eco", "iiu_type": "t", "source_description": "s", "score_direction": direction, "checklist_max": None, "display_order": 1}
        catalog = [indicator("eco01_pib_municipal_per_capita", "direct"), indicator("eco07_facilidade_para_abertura_de_empresas", "inverse"), indicator("eco03_densidade_de_empregos_formais", "direct")]
        dimensions = [{"code": "eco", "name": "Economia", "color": "#f59e0b", "display_order": 1, "weight": 100}]
        payloads = {"iiu_indicator_catalog": catalog, "iiu_dimension_catalog": dimensions, "iiu_indicator_benchmark_catalog": [], "dashboard_values": []}

        def fake_get(url, **_):
            response = Mock()
            response.is_success = True
            response.json.return_value = payloads[url.rsplit("/", 1)[1]]
            return response

        with patch.dict("os.environ", {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"}), patch.object(main.httpx, "get", side_effect=fake_get):
            body = TestClient(main.app).get("/iiu-dashboard/demo").json()
        self.assertTrue(body["is_demonstration"])
        self.assertEqual(body["observed_indicators"], 3)
        self.assertEqual(body["scored_indicators"], 3)
        self.assertIsNotNone(body["overall_score"])


if __name__ == "__main__":
    unittest.main()
