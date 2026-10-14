import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

from . import supabase_client
from .routes_iiu import get_iiu_dashboard, iiu_score, maturity_label, mean_score, weighted_overall_score, without_accents
from .supabase_client import upstream_error

router = APIRouter()

city_profiles = ("pequeno", "medio", "grande", "metropole")
rows_per_request = 1000
maximum_value_rows = 400_000
ranking_cache_seconds = 300
indicator_codes_per_request = 30
compare_municipalities_range = (2, 4)

ranking_cache: dict[str, tuple[float, dict[str, Any]]] = {}
ranking_locks = {city_profile: threading.Lock() for city_profile in city_profiles}


def clear_ranking_cache() -> None:
    ranking_cache.clear()


def validate_city_profile(city_profile: str) -> None:
    if city_profile not in city_profiles:
        raise HTTPException(422, "Escolha um porte de município válido para o cálculo do IIU.")


def validate_municipality_code(municipality_code: str) -> None:
    if not re.fullmatch(r"[0-9]{7}", municipality_code):
        raise HTTPException(422, "Informe um código IBGE de município com sete dígitos.")


def fetch_rows(path: str, params: dict[str, str], error_message: str, maximum_rows: int = maximum_value_rows) -> tuple[list[dict[str, Any]], bool]:
    collected: list[dict[str, Any]] = []
    for page_start in range(0, maximum_rows, rows_per_request):
        page_response = httpx.get(supabase_client.supabase_url(path), params={**params, "limit": rows_per_request, "offset": page_start}, headers=supabase_client.supabase_headers(), timeout=60.0)
        if not page_response.is_success:
            raise upstream_error(error_message, page_response)
        page_rows = page_response.json()
        collected.extend(page_rows)
        if len(page_rows) < rows_per_request:
            return collected, False
    return collected, True


def fetch_municipality_names(codes: list[str] | None = None) -> dict[str, dict[str, str]]:
    if codes is not None:
        response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_municipalities"), params={"select": "ibge_code,name,state", "ibge_code": f"in.({','.join(codes)})"}, headers=supabase_client.supabase_headers(), timeout=30.0)
        if not response.is_success:
            raise upstream_error("Não foi possível carregar os nomes dos municípios.", response)
        records = response.json()
    else:
        records, _ = fetch_rows("/rest/v1/iiu_municipalities", {"select": "ibge_code,name,state", "order": "ibge_code"}, "Não foi possível carregar os nomes dos municípios.", 20_000)
    return {record["ibge_code"]: {"name": record["name"], "state": record["state"]} for record in records}


def rank_municipalities(indicators: list[dict[str, Any]], dimensions: list[dict[str, Any]], benchmarks: list[dict[str, Any]], value_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    dimension_codes = {dimension["code"] for dimension in dimensions}
    indicators_by_code = {indicator["code"]: indicator for indicator in indicators if indicator["iiu_dimension_code"] in dimension_codes}
    benchmark_by_indicator = {benchmark["indicator_code"]: benchmark for benchmark in benchmarks}
    latest_rows: dict[str, dict[str, dict[str, Any]]] = {}
    for value_row in value_rows:
        municipality_code = str((value_row.get("dimensions") or {}).get("municipality_ibge_code") or "")
        if value_row.get("indicator_code") not in indicators_by_code or not re.fullmatch(r"[0-9]{7}", municipality_code):
            continue
        current_row = latest_rows.setdefault(municipality_code, {}).get(value_row["indicator_code"])
        if current_row is None or value_row["reference_period"] > current_row["reference_period"]:
            latest_rows[municipality_code][value_row["indicator_code"]] = value_row
    ranked: list[dict[str, Any]] = []
    for municipality_code, rows_by_indicator in latest_rows.items():
        scores_by_dimension: dict[str, list[float]] = {}
        observed_indicators = scored_indicators = 0
        for indicator_code, value_row in rows_by_indicator.items():
            if value_row.get("value") is None:
                continue
            observed_indicators += 1
            indicator, benchmark = indicators_by_code[indicator_code], benchmark_by_indicator.get(indicator_code)
            indicator_score = iiu_score(float(value_row["value"]), indicator["score_direction"], float(benchmark["minimum_value"]) if benchmark else None, float(benchmark["maximum_value"]) if benchmark else None, float(indicator["checklist_max"]) if indicator["checklist_max"] is not None else None)
            if indicator_score is None:
                continue
            scored_indicators += 1
            scores_by_dimension.setdefault(indicator["iiu_dimension_code"], []).append(indicator_score)
        dimension_scores = {dimension["code"]: mean_score(scores_by_dimension.get(dimension["code"], [])) for dimension in dimensions}
        overall_score = weighted_overall_score([(dimension_scores[dimension["code"]], float(dimension["weight"])) for dimension in dimensions if dimension_scores[dimension["code"]] is not None])
        if overall_score is None:
            continue
        ranked.append({"municipality_ibge_code": municipality_code, "overall_score": overall_score, "maturity": maturity_label(overall_score), "dimension_scores": dimension_scores, "scored_indicators": scored_indicators, "observed_indicators": observed_indicators})
    return ranked


def compute_ranking(city_profile: str) -> dict[str, Any]:
    headers = supabase_client.supabase_headers()
    catalog_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_indicator_catalog"), params={"select": "code,iiu_dimension_code,score_direction,checklist_max", "order": "display_order,name"}, headers=headers, timeout=30.0)
    dimension_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_dimension_catalog"), params={"city_profile": f"eq.{city_profile}", "select": "code,name,color,display_order,weight", "order": "display_order"}, headers=headers, timeout=30.0)
    benchmark_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_indicator_benchmark_catalog"), params={"city_profile": f"eq.{city_profile}", "select": "indicator_code,minimum_value,maximum_value"}, headers=headers, timeout=30.0)
    if not all(response.is_success for response in (catalog_response, dimension_response, benchmark_response)):
        raise HTTPException(502, "Não foi possível montar o ranking do IIU. Confirme se a migration 0012_iiu_framework.sql foi executada no Supabase.")
    indicators, dimensions, benchmarks = catalog_response.json(), dimension_response.json(), benchmark_response.json()
    benchmarked_codes = {benchmark["indicator_code"] for benchmark in benchmarks}
    scorable_codes = [indicator["code"] for indicator in indicators if indicator["score_direction"] == "checklist" or indicator["code"] in benchmarked_codes]
    value_rows: list[dict[str, Any]] = []
    truncated = False
    for chunk_start in range(0, len(scorable_codes), indicator_codes_per_request):
        chunk_rows, chunk_truncated = fetch_rows("/rest/v1/dashboard_values", {"indicator_code": f"in.({','.join(scorable_codes[chunk_start:chunk_start + indicator_codes_per_request])})", "select": "indicator_code,value,reference_period,dimensions", "order": "reference_period.desc,id"}, "Não foi possível ler os valores publicados para o ranking.", max(rows_per_request, maximum_value_rows - len(value_rows)))
        value_rows.extend(chunk_rows)
        truncated = truncated or chunk_truncated
    dimension_codes = {dimension["code"] for dimension in dimensions}
    ranked = rank_municipalities(indicators, dimensions, benchmarks, value_rows)
    names = fetch_municipality_names() if ranked else {}
    for ranked_row in ranked:
        municipality = names.get(ranked_row["municipality_ibge_code"], {})
        ranked_row["name"] = municipality.get("name") or ranked_row["municipality_ibge_code"]
        ranked_row["state"] = municipality.get("state")
    return {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "truncated": truncated, "total_indicators": sum(1 for indicator in indicators if indicator["iiu_dimension_code"] in dimension_codes), "dimensions": dimensions, "rows": ranked}


def cached_ranking(city_profile: str, refresh: bool) -> tuple[dict[str, Any], bool]:
    requested_at = time.monotonic()
    cached = ranking_cache.get(city_profile)
    if cached and not refresh and requested_at - cached[0] < ranking_cache_seconds:
        return cached[1], True
    with ranking_locks[city_profile]:
        cached = ranking_cache.get(city_profile)
        if cached and (cached[0] >= requested_at or (not refresh and time.monotonic() - cached[0] < ranking_cache_seconds)):
            return cached[1], True
        ranking = compute_ranking(city_profile)
        ranking_cache[city_profile] = (time.monotonic(), ranking)
        return ranking, False


def search_key(text: str) -> str:
    return without_accents(text).casefold()


def competition_ranks(ordered_scores: list[float]) -> list[int]:
    ranks: list[int] = []
    for index, score in enumerate(ordered_scores):
        ranks.append(ranks[-1] if index and score == ordered_scores[index - 1] else index + 1)
    return ranks


@router.get("/iiu-ranking")
def get_iiu_ranking(city_profile: str = "medio", dimension: str | None = None, search: str | None = None, sort: str = "score", direction: str | None = None, limit: int = 50, offset: int = 0, refresh: bool = False) -> dict[str, Any]:
    validate_city_profile(city_profile)
    ranking, from_cache = cached_ranking(city_profile, refresh)
    dimension_codes = [catalog_dimension["code"] for catalog_dimension in ranking["dimensions"]]
    dimension = dimension.strip() if dimension and dimension.strip() else None
    if dimension is not None and dimension not in dimension_codes:
        raise HTTPException(422, f"Dimensão desconhecida: {dimension}. Use uma de: {', '.join(dimension_codes)}.")
    if sort not in {"score", "name", "state", "coverage", *dimension_codes}:
        raise HTTPException(422, f"Ordenação inválida: {sort}.")
    if direction not in (None, "asc", "desc"):
        raise HTTPException(422, "A direção da ordenação precisa ser asc ou desc.")
    page_limit, page_offset = max(1, min(limit, 1000)), max(0, offset)

    def ranking_score(ranked_row: dict[str, Any]) -> float | None:
        return ranked_row["dimension_scores"].get(dimension) if dimension else ranked_row["overall_score"]

    eligible = sorted((ranked_row for ranked_row in ranking["rows"] if ranking_score(ranked_row) is not None), key=lambda ranked_row: (-ranking_score(ranked_row), search_key(ranked_row["name"])))
    ranks = competition_ranks([ranking_score(ranked_row) for ranked_row in eligible])
    ranked_items = [{**ranked_row, "rank": rank, "score": ranking_score(ranked_row)} for ranked_row, rank in zip(eligible, ranks)]
    search_text = search_key(search.strip()) if search and search.strip() else ""
    matching_items = [item for item in ranked_items if search_text in search_key(f"{item['name']} {item['state'] or ''} {item['municipality_ibge_code']}")] if search_text else ranked_items
    if sort != "score":
        descending = direction == "desc" if direction else sort not in {"name", "state"}
        sort_values = {"name": lambda item: search_key(item["name"]), "state": lambda item: (item["state"] or "", search_key(item["name"])), "coverage": lambda item: item["scored_indicators"]}
        if sort in sort_values:
            matching_items = sorted(matching_items, key=sort_values[sort], reverse=descending)
        else:
            with_score = sorted((item for item in matching_items if item["dimension_scores"][sort] is not None), key=lambda item: item["dimension_scores"][sort], reverse=descending)
            matching_items = with_score + [item for item in matching_items if item["dimension_scores"][sort] is None]
    elif direction == "asc":
        matching_items = list(reversed(matching_items))
    return {"city_profile": city_profile, "dimension": dimension, "generated_at": ranking["generated_at"], "cached": from_cache, "truncated": ranking["truncated"], "scored_municipalities": len(ranked_items), "total_indicators": ranking["total_indicators"], "dimensions": ranking["dimensions"], "total": len(matching_items), "limit": page_limit, "offset": page_offset, "items": matching_items[page_offset:page_offset + page_limit]}


def compact_dashboard(dashboard: dict[str, Any]) -> dict[str, Any]:
    return {**dashboard, "dimensions": [{**dimension, "indicators": [{key: value for key, value in indicator.items() if key not in ("formula", "source")} for indicator in dimension["indicators"]]} for dimension in dashboard["dimensions"]]}


@router.get("/iiu-compare")
def compare_iiu_municipalities(codes: str, city_profile: str = "medio") -> dict[str, Any]:
    validate_city_profile(city_profile)
    requested_codes = list(dict.fromkeys(code.strip() for code in codes.split(",") if code.strip()))
    for requested_code in requested_codes:
        validate_municipality_code(requested_code)
    minimum_count, maximum_count = compare_municipalities_range
    if not minimum_count <= len(requested_codes) <= maximum_count:
        raise HTTPException(422, f"Escolha de {minimum_count} a {maximum_count} municípios diferentes para comparar.")
    with ThreadPoolExecutor(max_workers=len(requested_codes)) as executor:
        dashboards = list(executor.map(lambda requested_code: get_iiu_dashboard(requested_code, city_profile), requested_codes))
    names = fetch_municipality_names(requested_codes)
    return {"city_profile": city_profile, "municipalities": [{**compact_dashboard(dashboard), "name": names.get(dashboard["municipality_ibge_code"], {}).get("name"), "state": names.get(dashboard["municipality_ibge_code"], {}).get("state")} for dashboard in dashboards]}


@router.get("/iiu-timeseries/{municipality_code}")
def get_iiu_timeseries(municipality_code: str, indicator_code: str | None = None) -> dict[str, Any]:
    validate_municipality_code(municipality_code)
    municipality = fetch_municipality_names([municipality_code]).get(municipality_code)
    if municipality is None:
        raise HTTPException(404, "Município não encontrado.")
    municipality_fields = {"municipality_ibge_code": municipality_code, "municipality_name": municipality["name"], "state": municipality["state"]}
    municipality_filter = {"dimensions->>municipality_ibge_code": f"eq.{municipality_code}"}
    if not indicator_code:
        value_rows, truncated = fetch_rows("/rest/v1/dashboard_values", {**municipality_filter, "select": "indicator_code,indicator_name,unit,reference_period", "order": "indicator_code,reference_period"}, "Não foi possível listar os indicadores do município.", 20_000)
        summaries: dict[str, dict[str, Any]] = {}
        for value_row in value_rows:
            summary = summaries.setdefault(value_row["indicator_code"], {"code": value_row["indicator_code"], "name": value_row["indicator_name"], "unit": value_row["unit"], "observations": 0, "first_period": value_row["reference_period"], "last_period": value_row["reference_period"]})
            summary["observations"] += 1
            summary["first_period"], summary["last_period"] = min(summary["first_period"], value_row["reference_period"]), max(summary["last_period"], value_row["reference_period"])
        return {**municipality_fields, "truncated": truncated, "indicators": sorted(summaries.values(), key=lambda summary: summary["name"])}
    query_parameters: dict[str, str] = {**municipality_filter, "indicator_code": f"eq.{indicator_code}", "select": "id,indicator_code,indicator_name,reference_period,value,unit,source_name,import_title", "order": "reference_period.asc,id", "limit": "1000"}
    values_response = httpx.get(supabase_client.supabase_url("/rest/v1/dashboard_values"), params={**query_parameters, "select": f"{query_parameters['select']},period_granularity"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    if values_response.status_code == 400:
        values_response = httpx.get(supabase_client.supabase_url("/rest/v1/dashboard_values"), params=query_parameters, headers=supabase_client.supabase_headers(), timeout=30.0)
    if not values_response.is_success:
        raise upstream_error("Não foi possível carregar a série do indicador.", values_response)
    points = [{"reference_period": value_row["reference_period"], "value": value_row["value"], "unit": value_row["unit"], "source_name": value_row["source_name"], "import_title": value_row["import_title"], "period_granularity": value_row.get("period_granularity")} for value_row in values_response.json()]
    first_row = values_response.json()[0] if points else None
    return {**municipality_fields, "indicator": {"code": indicator_code, "name": first_row["indicator_name"], "unit": first_row["unit"]} if first_row else None, "points": points}
