import time
import unittest
from decimal import Decimal
from unittest.mock import Mock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from services.ingestion.app import approval, jobs, main, population, row_filters


def staged(row_number, raw_row):
    return {"id": row_number, "sheet_name": "Dados", "row_number": row_number, "raw_row": raw_row, "normalized_row": {}}


def sidra_rows(values):
    return [{"NC": "6", "V": str(value), "D1C": code, "D3C": "2024"} for code, value in values.items()]


class PopulationTests(unittest.TestCase):
    def setUp(self):
        population.population_cache.clear()

    def test_parses_sidra_rows_and_ignores_bad_codes_and_values(self):
        rows = sidra_rows({"3509502": 1185977, "3550308": 11451999}) + [{"V": "...", "D1C": "3304557"}, {"V": "10", "D1C": "12"}]
        self.assertEqual(population.parse_sidra_population(rows), {"3509502": 1185977, "3550308": 11451999})
        self.assertEqual(population.parse_sidra_population({"erro": 1}), {})

    def test_census_year_falls_back_to_the_census_table(self):
        self.assertEqual(len(population.population_sources(2024)), 1)
        self.assertEqual(len(population.population_sources(2022)), 2)
        self.assertIn("/t/4709/", population.population_sources(2022)[1])

    def test_year_without_data_is_a_clear_422_and_a_successful_year_is_cached(self):
        def fake_get(url, **_):
            response = Mock()
            response.is_success = True
            response.json.return_value = sidra_rows({f"{1100000 + index:07d}": 1000 + index for index in range(1200)}) if "/p/2024/" in url else []
            return response

        with patch.object(population.httpx, "get", side_effect=fake_get) as get:
            self.assertEqual(len(population.population_by_municipality(2024)), 1200)
            population.population_by_municipality(2024)
            self.assertEqual(get.call_count, 1)
            with self.assertRaises(HTTPException) as unavailable:
                population.population_by_municipality(1999)
        self.assertEqual(unavailable.exception.status_code, 422)
        self.assertIn("1999", unavailable.exception.detail)


class PerCapitaPreparationTests(unittest.TestCase):
    def setUp(self):
        self.period = main.PeriodSelection(mode="year_column", year_field="ano")
        self.mapping = {"indicator_id": "leitos", "indicator_code": "qvi03_leitos", "calculation_type": "ratio", "numerator_field": "leitos", "denominator_field": None, "denominator_source": "population", "calculation_multiplier": 1000, "prepared_field": "decsys_value__qvi03_leitos"}

    def test_divides_by_the_population_of_the_row_year_and_applies_the_multiplier(self):
        lookup = approval.CachedPopulationLookup()
        with patch.object(population, "population_by_municipality", return_value={"3509502": 1000000}):
            rows, summary = approval.prepare_rows_for_batch_approval([staged(1, {"municipio": "3509502", "ano": "2024", "leitos": "2.500"})], self.period, [self.mapping], "municipio", lambda code: code, lookup)
        self.assertEqual(rows[0][1]["decsys_value__qvi03_leitos"], "2.5")
        self.assertEqual(rows[0][1]["indicator_calculations"]["qvi03_leitos"]["type"], "ratio_population")
        self.assertEqual(summary["indicator_problems"]["leitos"]["value_problem_count"], 0)

    def test_municipality_or_year_without_population_becomes_a_problem_not_a_crash(self):
        lookup = approval.CachedPopulationLookup()
        unavailable = HTTPException(422, "sem população")
        with patch.object(population, "population_by_municipality", side_effect=[{"3509502": 1000000}, unavailable]):
            rows, summary = approval.prepare_rows_for_batch_approval(
                [staged(1, {"municipio": "3509502", "ano": "2024", "leitos": "10"}), staged(2, {"municipio": "9999999", "ano": "2024", "leitos": "10"}), staged(3, {"municipio": "3509502", "ano": "1999", "leitos": "10"})],
                self.period, [self.mapping], "municipio", lambda code: code, lookup)
        self.assertEqual([row[1]["decsys_value__qvi03_leitos"] for row in rows], ["0.01", None, None])
        self.assertEqual(summary["indicator_problems"]["leitos"]["value_problem_count"], 2)
        self.assertEqual(lookup.missing_years, {1999})

    def test_zero_or_missing_numerator_never_divides(self):
        lookup = approval.CachedPopulationLookup()
        with patch.object(population, "population_by_municipality", return_value={"3509502": 0}):
            rows, _ = approval.prepare_rows_for_batch_approval([staged(1, {"municipio": "3509502", "ano": "2024", "leitos": "10"})], self.period, [self.mapping], "municipio", lambda code: code, lookup)
        self.assertIsNone(rows[0][1]["decsys_value__qvi03_leitos"])


class ValueLimitTests(unittest.TestCase):
    def test_clamp_value_text(self):
        self.assertEqual(approval.clamp_value_text("408.87", None, 100), "100")
        self.assertEqual(approval.clamp_value_text("-3", 0, None), "0")
        self.assertEqual(approval.clamp_value_text("55.5", 0, 100), "55.5")
        self.assertEqual(approval.clamp_value_text(None, 0, 100), None)
        self.assertEqual(approval.clamp_value_text("12.30", None, None), "12.30")

    def test_limits_are_applied_to_direct_values_during_preparation(self):
        period = main.PeriodSelection(mode="year_column", year_field="ano")
        mapping = {"indicator_id": "aps", "indicator_code": "qvi02", "calculation_type": "direct", "value_field": "cobertura", "prepared_field": "decsys_value__qvi02", "calculation_multiplier": 1, "value_max": 100}
        rows, _ = approval.prepare_rows_for_batch_approval([staged(1, {"municipio": "3509502", "ano": "2026", "cobertura": "408,87"})], period, [mapping], "municipio", lambda code: code)
        self.assertEqual(rows[0][1]["decsys_value__qvi02"], "100")


class RowFilterTests(unittest.TestCase):
    rows = [{"sexo": "Total", "ano": "2021", "valor": "10"}, {"sexo": "Total", "ano": "2022", "valor": "20"}, {"sexo": "Homens", "ano": "2022", "valor": "5"}, {"sexo": "Mulheres", "ano": 2022.0, "valor": "15"}]

    def apply(self, filters=None, latest=None):
        return row_filters.apply_row_filters(self.rows, row_filters.RowFilterRequest(filters=filters or [], keep_latest_of=latest))

    def test_equals_is_case_insensitive_and_all_filters_must_pass(self):
        kept = self.apply([row_filters.RowFilter(field="sexo", operator="eq", value="total"), row_filters.RowFilter(field="ano", operator="eq", value="2022")])
        self.assertEqual([row["valor"] for row in kept], ["20"])

    def test_in_neq_contains_and_numeric_comparisons(self):
        self.assertEqual(len(self.apply([row_filters.RowFilter(field="sexo", operator="in", value="Homens; Mulheres")])), 2)
        self.assertEqual(len(self.apply([row_filters.RowFilter(field="sexo", operator="neq", value="Total")])), 2)
        self.assertEqual(len(self.apply([row_filters.RowFilter(field="sexo", operator="contains", value="OMEN")])), 1)
        self.assertEqual(len(self.apply([row_filters.RowFilter(field="valor", operator="gte", value="10")])), 3)
        self.assertEqual(len(self.apply([row_filters.RowFilter(field="valor", operator="lte", value="10,0")])), 2)

    def test_keep_latest_uses_the_numeric_maximum_even_with_floats_and_strings(self):
        kept = self.apply(latest="ano")
        self.assertEqual(sorted(row["valor"] for row in kept), ["15", "20", "5"])

    def test_latest_is_taken_after_the_other_filters(self):
        kept = self.apply([row_filters.RowFilter(field="sexo", operator="eq", value="Total")], latest="ano")
        self.assertEqual([row["valor"] for row in kept], ["20"])

    def test_filter_endpoint_creates_a_derived_sheet_and_refuses_empty_results(self):
        staged_rows = [staged(index, row) for index, row in enumerate(self.rows, start=1)]
        body = {"sheet_name": "Dados", "filters": [{"field": "sexo", "operator": "eq", "value": "Total"}], "keep_latest_of": "ano"}
        with patch("services.ingestion.app.municipalities.fetch_rows_for_municipality_resolution", return_value=staged_rows), patch("services.ingestion.app.import_store.write_derived_sheet", return_value=1) as write:
            ok = TestClient(main.app).post("/imports/imp-1/filter-rows", json=body)
            empty = TestClient(main.app).post("/imports/imp-1/filter-rows", json={**body, "filters": [{"field": "sexo", "operator": "eq", "value": "Nada"}]})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual((ok.json()["sheet_name"], ok.json()["total_rows"], ok.json()["kept_rows"]), ("Dados · filtrada", 4, 1))
        self.assertEqual(write.call_args.args[:3], ("imp-1", "Dados · filtrada", "Dados"))
        self.assertEqual(empty.status_code, 422)
        self.assertEqual(TestClient(main.app).post("/imports/imp-1/filter-rows", json={"filters": []}).status_code, 422)


class JobsTests(unittest.TestCase):
    def wait(self, job):
        for _ in range(100):
            if job.status != "running":
                return
            time.sleep(0.02)
        self.fail("a tarefa não terminou")

    def test_job_reports_progress_and_returns_the_result(self):
        def work(job):
            job.report("Meio do caminho", 0.5)
            return {"ok": True}

        job = jobs.start_job("teste", "imp-1", work)
        self.wait(job)
        self.assertEqual((job.status, job.progress, job.result), ("done", 1.0, {"ok": True}))
        self.assertEqual(TestClient(main.app).get(f"/jobs/{job.id}").json()["status"], "done")

    def test_http_errors_keep_their_status_and_message(self):
        job = jobs.start_job("teste", None, lambda running: (_ for _ in ()).throw(HTTPException(422, "Valor inválido.")))
        self.wait(job)
        self.assertEqual((job.status, job.error, job.error_status), ("error", "Valor inválido.", 422))

    def test_unexpected_errors_are_reported_not_lost(self):
        job = jobs.start_job("teste", None, lambda running: 1 / 0)
        self.wait(job)
        self.assertEqual(job.status, "error")
        self.assertIn("division by zero", job.error)

    def test_unknown_job_is_404_with_guidance(self):
        response = TestClient(main.app).get("/jobs/nao-existe")
        self.assertEqual(response.status_code, 404)
        self.assertIn("Importações salvas", response.json()["detail"])


class ChunkedApprovalTests(unittest.TestCase):
    def run_approval(self, row_count, chunk_rows):
        indicators = [{"id": "ind", "code": "qvi02", "name": "QVI02", "active": True, "calculation_type": "direct", "unit": "%"}]
        rows = [staged(index, {"municipio": "3509502", "ano": str(2000 + index), "valor": "10"}) for index in range(1, row_count + 1)]

        def fake_get(url, **_):
            response = Mock()
            response.is_success = True
            response.json.return_value = indicators
            return response

        def fake_post(url, **kwargs):
            response = Mock()
            response.status_code = 200
            response.is_success = True
            count = 1
            response.json.return_value = {"status": "approved", "approved_value_count": count, "indicators": [{"indicator_id": "ind", "approved_rows": count}]}
            return response

        approval_request = main.MunicipalBatchApproval(municipality_field="municipio", sheet_name="Dados", period=main.PeriodSelection(mode="year_column", year_field="ano"), mappings=[main.MunicipalIndicatorMapping(indicator_id="ind", value_field="valor", unit="%")])
        with patch.object(approval.httpx, "get", side_effect=fake_get), patch.object(approval.httpx, "post", side_effect=fake_post) as post, \
                patch("services.ingestion.app.municipalities.ensure_municipal_catalog_registered"), patch("services.ingestion.app.municipalities.fetch_rows_for_municipality_resolution", return_value=rows), \
                patch("services.ingestion.app.municipalities.ibge_municipality_catalog", return_value=[]), patch.object(approval, "municipality_code_resolver", return_value=lambda value: value), \
                patch("services.ingestion.app.supabase_client.supabase_url", side_effect=lambda path: f"https://s.test{path}"), patch("services.ingestion.app.supabase_client.supabase_headers", return_value={}), \
                patch("services.ingestion.app.import_store.upsert_staged_rows") as upsert, patch("services.ingestion.app.import_store.write_derived_sheet", return_value=0) as derived, \
                patch("services.ingestion.app.config.approval_chunk_rows", chunk_rows):
            phases = []
            result = approval.run_batch_approval("imp-1", approval_request, lambda phase, fraction=None: phases.append(phase))
        return result, post, upsert, derived, phases

    def test_small_imports_keep_the_single_sheet_path(self):
        result, post, upsert, derived, _ = self.run_approval(10, 500)
        self.assertEqual(result["chunks"], 1)
        upsert.assert_called_once()
        derived.assert_not_called()
        self.assertEqual(post.call_count, 1)

    def test_large_imports_are_split_into_derived_sheets_and_summed(self):
        result, post, upsert, derived, phases = self.run_approval(1200, 500)
        self.assertEqual(result["chunks"], 3)
        self.assertEqual(derived.call_count, 3)
        upsert.assert_not_called()
        self.assertEqual([call.args[1] for call in derived.call_args_list], ["Dados · parte 1 de 3", "Dados · parte 2 de 3", "Dados · parte 3 de 3"])
        self.assertEqual([len(call.args[3]) for call in derived.call_args_list], [500, 500, 200])
        self.assertEqual([call.kwargs["json"]["selected_sheet_name"] for call in post.call_args_list], ["Dados · parte 1 de 3", "Dados · parte 2 de 3", "Dados · parte 3 de 3"])
        self.assertEqual(result["approved_value_count"], 3)
        self.assertEqual(result["indicator_results"][0]["approved_rows"], 3)
        self.assertEqual(result["status"], "approved")
        self.assertTrue(any("parte 2 de 3" in phase for phase in phases))

    def test_background_flag_returns_202_and_a_job(self):
        with patch.object(approval, "run_batch_approval", return_value={"status": "approved"}):
            response = TestClient(main.app).post("/imports/imp-1/approve-municipal-batch?background=true", json={"municipality_field": "municipio", "period": {"mode": "year_column", "year_field": "ano"}, "mappings": [{"indicator_id": "ind", "value_field": "valor", "unit": "%"}]})
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["kind"], "approve")
        self.assertIn(response.json()["status"], {"running", "done"})

    def test_inverted_limits_are_rejected_before_touching_the_database(self):
        mapping = main.MunicipalIndicatorMapping(indicator_id="ind", value_field="valor", unit="%", value_min=10, value_max=5)
        request = main.MunicipalBatchApproval(municipality_field="municipio", period=main.PeriodSelection(mode="year_column", year_field="ano"), mappings=[mapping])
        with patch.object(approval.httpx, "get", return_value=Mock(is_success=True, json=Mock(return_value=[{"id": "ind", "code": "x", "name": "X", "active": True, "calculation_type": "direct"}]))), \
                patch("services.ingestion.app.supabase_client.supabase_url", return_value="https://s.test"), patch("services.ingestion.app.supabase_client.supabase_headers", return_value={}):
            with self.assertRaises(HTTPException) as error:
                approval.run_batch_approval("imp-1", request)
        self.assertEqual(error.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
