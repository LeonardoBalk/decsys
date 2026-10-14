from typing import Any, Literal

import httpx
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from . import jobs, population, supabase_client
from .models import IiuBenchmarkUpdate
from .routes_iiu import latest_value_per_municipality, percentile, update_iiu_indicator_benchmark
from .supabase_client import upstream_error

router = APIRouter()
CityProfile = Literal["pequeno", "medio", "grande", "metropole"]
all_profiles: tuple[str, ...] = ("pequeno", "medio", "grande", "metropole")
minimum_sample = {"pequeno": 30, "medio": 30, "grande": 30, "metropole": 10}
reliable_sample = 30


class AutomaticBenchmarks(BaseModel):
    city_profiles: list[CityProfile] = Field(default_factory=lambda: list(all_profiles))
    indicator_codes: list[str] | None = None


def fetch_indicator_values(indicator_code: str, only_probe: bool = False) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    page_size = 1 if only_probe else 1000
    for page_start in range(0, 200_000, page_size):
        page_response = httpx.get(supabase_client.supabase_url("/rest/v1/dashboard_values"), params={"indicator_code": f"eq.{indicator_code}", "select": "value,reference_period,dimensions", "order": "reference_period.desc,id", "limit": page_size, "offset": page_start}, headers=supabase_client.supabase_headers(), timeout=60.0)
        if not page_response.is_success:
            raise upstream_error("Não foi possível ler os valores publicados do indicador.", page_response)
        rows = page_response.json()
        collected.extend(rows)
        if only_probe or len(rows) < page_size:
            break
    return collected


def range_from_values(values: list[float], minimum: int) -> dict[str, Any] | None:
    if len(values) < minimum:
        return None
    ordered = sorted(values)
    low, high = percentile(ordered, 0.10), percentile(ordered, 0.90)
    if low >= high:
        return None
    return {"sample_size": len(ordered), "minimum_value": round(low, 4), "maximum_value": round(high, 4), "reliability": "alta" if len(ordered) >= reliable_sample else "baixa"}


def suggestions_for_rows(rows: list[dict[str, Any]], population_by_code: dict[str, int] | None) -> dict[str, Any]:
    municipal_rows = latest_value_per_municipality(rows)
    overall = range_from_values([float(row["value"]) for row in municipal_rows], minimum_sample["medio"])
    profiles: dict[str, dict[str, Any] | None] = {profile: None for profile in all_profiles}
    if population_by_code:
        grouped: dict[str, list[float]] = {profile: [] for profile in all_profiles}
        for row in municipal_rows:
            inhabitants = population_by_code.get(row["dimensions"]["municipality_ibge_code"])
            if inhabitants:
                grouped[population.city_profile_for_population(inhabitants)].append(float(row["value"]))
        profiles = {profile: range_from_values(grouped[profile], minimum_sample[profile]) for profile in all_profiles}
    return {"municipalities": len(municipal_rows), "overall": overall, "profiles": profiles}


@router.get("/iiu-configuration/benchmark-suggestion/by-profile")
def suggest_benchmark_by_profile(indicator_code: str) -> dict[str, Any]:
    rows = fetch_indicator_values(indicator_code)
    try:
        population_year, population_by_code = population.latest_population()
    except HTTPException:
        population_year, population_by_code = None, None
    suggestions = suggestions_for_rows(rows, population_by_code)
    if not suggestions["overall"] and not any(suggestions["profiles"].values()):
        raise HTTPException(422, f"Há valores de {suggestions['municipalities']} município(s); são necessários pelo menos {minimum_sample['medio']} para sugerir uma faixa confiável.")
    return {"indicator_code": indicator_code, "population_year": population_year, **suggestions}


@router.get("/iiu-municipality-profile/{municipality_code}")
def municipality_profile(municipality_code: str) -> dict[str, Any]:
    if not municipality_code.isdigit() or len(municipality_code) != 7:
        raise HTTPException(422, "Informe um código IBGE de sete dígitos.")
    year, by_code = population.latest_population()
    inhabitants = by_code.get(municipality_code)
    if not inhabitants:
        raise HTTPException(404, "O IBGE não informa a população deste município.")
    return {"municipality_ibge_code": municipality_code, "population": inhabitants, "population_year": year, "city_profile": population.city_profile_for_population(inhabitants)}


def run_automatic_benchmarks(request: AutomaticBenchmarks, progress: Any = None) -> dict[str, Any]:
    report = progress or (lambda phase, fraction=None: None)
    report("Listando os indicadores do IIU", 0.02)
    catalog_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_indicator_catalog"), params={"select": "code,name"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    if not catalog_response.is_success:
        raise upstream_error("Não foi possível listar os indicadores do IIU.", catalog_response)
    catalog = [item for item in catalog_response.json() if not request.indicator_codes or item["code"] in request.indicator_codes]
    try:
        population_year, population_by_code = population.latest_population()
    except HTTPException:
        population_year, population_by_code = None, None
    saved: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    for index, indicator in enumerate(catalog, start=1):
        report(f"Calculando faixas ({index} de {len(catalog)}): {indicator['name']}", 0.05 + 0.9 * (index - 1) / max(1, len(catalog)))
        if not fetch_indicator_values(indicator["code"], only_probe=True):
            continue
        suggestions = suggestions_for_rows(fetch_indicator_values(indicator["code"]), population_by_code)
        for profile in request.city_profiles:
            chosen, origin = suggestions["profiles"].get(profile), "porte"
            if chosen is None and suggestions["overall"]:
                chosen, origin = suggestions["overall"], "geral"
            if chosen is None:
                skipped.append({"indicator_code": indicator["code"], "city_profile": profile, "reason": "amostra insuficiente"})
                continue
            update_iiu_indicator_benchmark(IiuBenchmarkUpdate(indicator_code=indicator["code"], city_profile=profile, minimum_value=chosen["minimum_value"], maximum_value=chosen["maximum_value"]))
            saved.append({"indicator_code": indicator["code"], "city_profile": profile, "origin": origin, "sample_size": chosen["sample_size"], "minimum_value": chosen["minimum_value"], "maximum_value": chosen["maximum_value"], "reliability": chosen["reliability"]})
    report("Concluído", 1.0)
    return {"population_year": population_year, "indicators_with_data": len({item["indicator_code"] for item in saved} | {item["indicator_code"] for item in skipped}), "saved": len(saved), "skipped": len(skipped), "details": saved[:200], "skipped_details": skipped[:50]}


@router.post("/iiu-configuration/benchmarks/auto")
def apply_automatic_benchmarks(request: AutomaticBenchmarks, response: Response, background: bool = False) -> dict[str, Any]:
    if background:
        job = jobs.start_job("benchmarks", None, lambda running_job: run_automatic_benchmarks(request, running_job.report))
        response.status_code = 202
        return job.public()
    return run_automatic_benchmarks(request)
