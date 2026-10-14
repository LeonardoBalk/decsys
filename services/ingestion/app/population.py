"""População residente por município (IBGE/SIDRA), usada como denominador de indicadores per capita."""
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
    """Estimativas anuais (tabela 6579) e, nos anos de Censo, a tabela do Censo. A ordem é a de preferência."""
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
    """Código IBGE de 7 dígitos -> habitantes no ano. Falha com mensagem clara se a SIDRA não tiver o ano."""
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
