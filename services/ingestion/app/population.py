import threading
import time
from typing import Any

import httpx
from fastapi import HTTPException

SIDRA_VALUES = "https://apisidra.ibge.gov.br/values"
population_cache_ttl_seconds = 24 * 60 * 60
population_cache: dict[int, dict[str, Any]] = {}
population_cache_lock = threading.Lock()
maximum_distinct_years = 40


def population_sources(year: int) -> list[str]:
    sources = [f"{SIDRA_VALUES}/t/6579/n6/all/v/9324/p/{year}/h/n"]
    if year == 2022:
        sources.append(f"{SIDRA_VALUES}/t/4709/n6/all/v/93/p/2022/h/n")
    return sources


def parse_sidra_population(rows: Any) -> dict[str, int]:
    population: dict[str, int] = {}
    if not isinstance(rows, list):
        return population
    for row in rows:
        code, value = str(row.get("D1C", "")).strip(), str(row.get("V", "")).strip()
        if len(code) == 7 and value.isdigit():
            population[code] = int(value)
    return population


def population_by_municipality(year: int) -> dict[str, int]:
    with population_cache_lock:
        cached = population_cache.get(year)
        if cached and cached["expires_at"] > time.time():
            return cached["by_code"]
    for source_url in population_sources(year):
        try:
            response = httpx.get(source_url, timeout=120.0)
        except httpx.TransportError:
            raise HTTPException(502, "Não foi possível consultar a população no IBGE (SIDRA). Tente novamente em instantes.")
        if not response.is_success:
            continue
        by_code = parse_sidra_population(response.json())
        if len(by_code) >= 1000:
            with population_cache_lock:
                population_cache[year] = {"expires_at": time.time() + population_cache_ttl_seconds, "by_code": by_code}
            return by_code
    raise HTTPException(422, f"O IBGE não publica a população por município para {year}. Use uma coluna de população da própria planilha como denominador.")


def population_lookup_for_years(years: set[int]) -> dict[int, dict[str, int]]:
    if len(years) > maximum_distinct_years:
        raise HTTPException(422, f"A planilha tem {len(years)} anos diferentes; para dividir pela população use até {maximum_distinct_years}.")
    return {year: population_by_municipality(year) for year in sorted(years)}


city_profile_limits = (("pequeno", 50_000), ("medio", 300_000), ("grande", 1_000_000))
latest_population_cache: dict[str, Any] = {"expires_at": 0.0, "year": None, "by_code": {}}


def city_profile_for_population(inhabitants: int) -> str:
    for profile, upper_limit in city_profile_limits:
        if inhabitants <= upper_limit:
            return profile
    return "metropole"


def latest_population(today_year: int | None = None) -> tuple[int, dict[str, int]]:
    with population_cache_lock:
        if latest_population_cache["expires_at"] > time.time() and latest_population_cache["year"]:
            return latest_population_cache["year"], latest_population_cache["by_code"]
    start_year = today_year or time.gmtime().tm_year
    for year in [*range(start_year, start_year - 4, -1), 2022]:
        try:
            by_code = population_by_municipality(year)
        except HTTPException as unavailable:
            if unavailable.status_code != 422:
                raise
            continue
        with population_cache_lock:
            latest_population_cache.update({"expires_at": time.time() + population_cache_ttl_seconds, "year": year, "by_code": by_code})
        return year, by_code
    raise HTTPException(503, "Não foi possível obter a população dos municípios no IBGE para classificar o porte.")
