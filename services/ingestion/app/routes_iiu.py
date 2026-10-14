import calendar
import httpx
import math
import re
import unicodedata
from datetime import date
from fastapi import HTTPException
from typing import Any, Literal
from fastapi import APIRouter

from . import supabase_client
from .models import IiuBenchmarkUpdate, IiuWeightsUpdate
from .supabase_client import registry_error, upstream_error

router = APIRouter()


iiu_demonstration_values = {
    "eco01": 48500.0, "eco02": 72.0, "eco03": 38.0, "eco04": 3100.0, "eco06": 26.0, "eco07": 9.0,
    "pes01": 96.0, "pes02": 22.0, "pes03": 97.0, "pes05": 6.1, "pes07": 11.0,
    "gov02": 3.0, "gov04": 78.0, "gov07": 35.0, "gov09": 48.0, "gov10": 55.0,
    "mob01": 14.0, "mob02": 40.0, "mob03": 520.0, "mob05": 11.0, "mob10": 3.0,
    "amb01": 91.0, "amb02": 72.0, "amb03": 60.0, "amb04": 38.0, "amb05": 94.0, "amb06": 24.0, "amb08": 30.0, "amb10": 3.2, "amb19": 55.0,
    "qvi01": 10.0, "qvi02": 77.0, "qvi03": 2.2, "qvi04": 2.4, "qvi08": 13.0, "qvi10": 18.0, "qvi17": 9.0, "qvi24": 3.0,
    "idd01": 78.0, "idd02": 70.0, "idd03": 88.0, "idd05": 2.0, "idd08": 5.0, "idd10": 4.0,
}

@router.get("/iiu-configuration")
def get_iiu_configuration(city_profile: Literal["pequeno", "medio", "grande", "metropole"] = "medio") -> dict[str, Any]:
    dimension_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_dimension_catalog"), params={"city_profile": f"eq.{city_profile}", "select": "code,name,color,display_order,weight", "order": "display_order"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    indicator_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_indicator_catalog"), params={"select": "code,name,dimension,unit,display_order", "order": "display_order,name"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    benchmark_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_indicator_benchmark_catalog"), params={"city_profile": f"eq.{city_profile}", "select": "indicator_code,minimum_value,maximum_value"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    history_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_configuration_history"), params={"select": "entity_type,entity_key,old_values,new_values,changed_at", "order": "changed_at.desc", "limit": "30"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    if not all(response.is_success for response in (dimension_response, indicator_response, benchmark_response, history_response)):
        raise HTTPException(503, "Execute a migration 0018_indicator_and_iiu_configuration.sql no Supabase para configurar fórmulas, pesos e referências.")
    benchmarks_by_indicator = {benchmark["indicator_code"]: benchmark for benchmark in benchmark_response.json()}
    configured_indicators = [{**indicator, **benchmarks_by_indicator.get(indicator["code"], {"minimum_value": None, "maximum_value": None})} for indicator in indicator_response.json()]
    return {"city_profile": city_profile, "dimensions": dimension_response.json(), "indicators": configured_indicators, "history": history_response.json()}

@router.put("/iiu-configuration/weights")
def update_iiu_dimension_weights(configuration: IiuWeightsUpdate) -> dict[str, Any]:
    if len(configuration.weights) < 2 or any(not math.isfinite(weight) or weight <= 0 or weight > 100 for weight in configuration.weights.values()):
        raise HTTPException(422, "Informe um peso maior que zero e de até 100 para cada dimensão.")
    if abs(sum(configuration.weights.values()) - 100) > 0.01:
        raise HTTPException(422, "A soma dos pesos precisa ser exatamente 100%.")
    save_response = httpx.post(supabase_client.supabase_url("/rest/v1/rpc/save_iiu_dimension_weights"), headers=supabase_client.supabase_headers(), json={"selected_city_profile": configuration.city_profile, "selected_weights": configuration.weights}, timeout=30.0)
    if not save_response.is_success:
        raise registry_error("Nao foi possivel salvar os pesos do IIU.", save_response)
    return {"city_profile": configuration.city_profile, "updated_dimensions": int(save_response.json())}

@router.put("/iiu-configuration/benchmark")
def update_iiu_indicator_benchmark(configuration: IiuBenchmarkUpdate) -> dict[str, Any]:
    if not math.isfinite(configuration.minimum_value) or not math.isfinite(configuration.maximum_value) or configuration.minimum_value >= configuration.maximum_value:
        raise HTTPException(422, "A referência máxima precisa ser maior que a mínima.")
    save_response = httpx.post(supabase_client.supabase_url("/rest/v1/rpc/save_iiu_indicator_benchmark"), headers=supabase_client.supabase_headers(), json={"selected_indicator_code": configuration.indicator_code, "selected_city_profile": configuration.city_profile, "selected_minimum": configuration.minimum_value, "selected_maximum": configuration.maximum_value}, timeout=30.0)
    if not save_response.is_success:
        raise registry_error("Nao foi possivel salvar as referencias do indicador.", save_response)
    return save_response.json()

benchmark_suggestion_minimum_sample = 30

def percentile(sorted_values: list[float], fraction: float) -> float:
    position = (len(sorted_values) - 1) * fraction
    lower_index = int(position)
    upper_index = min(lower_index + 1, len(sorted_values) - 1)
    return sorted_values[lower_index] + (sorted_values[upper_index] - sorted_values[lower_index]) * (position - lower_index)

def latest_value_per_municipality(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        municipality_code = (row.get("dimensions") or {}).get("municipality_ibge_code")
        if not municipality_code or row.get("value") is None:
            continue
        current = latest.get(municipality_code)
        if current is None or row["reference_period"] > current["reference_period"]:
            latest[municipality_code] = row
    return list(latest.values())

@router.get("/iiu-configuration/benchmark-suggestion")
def suggest_iiu_indicator_benchmark(indicator_code: str) -> dict[str, Any]:
    collected: list[dict[str, Any]] = []
    page_size = 1000
    for page_start in range(0, 200_000, page_size):
        page_response = httpx.get(supabase_client.supabase_url("/rest/v1/dashboard_values"), params={"indicator_code": f"eq.{indicator_code}", "select": "value,reference_period,dimensions", "order": "reference_period.desc,id", "limit": page_size, "offset": page_start}, headers=supabase_client.supabase_headers(), timeout=60.0)
        if not page_response.is_success:
            raise upstream_error("Não foi possível ler os valores publicados do indicador.", page_response)
        page_rows = page_response.json()
        collected.extend(page_rows)
        if len(page_rows) < page_size:
            break
    municipal_rows = latest_value_per_municipality(collected)
    sorted_values = sorted(float(row["value"]) for row in municipal_rows)
    if len(sorted_values) < benchmark_suggestion_minimum_sample:
        raise HTTPException(422, f"Há valores de {len(sorted_values)} município(s); são necessários pelo menos {benchmark_suggestion_minimum_sample} para sugerir uma faixa confiável.")
    minimum_value, maximum_value = percentile(sorted_values, 0.10), percentile(sorted_values, 0.90)
    if minimum_value >= maximum_value:
        raise HTTPException(422, "Os valores publicados quase não variam entre os municípios, então não dá para sugerir uma faixa.")
    reference_periods = sorted({row["reference_period"] for row in municipal_rows})
    return {"indicator_code": indicator_code, "sample_size": len(sorted_values), "minimum_value": round(minimum_value, 4), "maximum_value": round(maximum_value, 4), "method": "percentis 10 e 90", "reference_period_from": reference_periods[0], "reference_period_to": reference_periods[-1], "observed_minimum": sorted_values[0], "observed_maximum": sorted_values[-1]}

def total_from_content_range(content_range: str | None, fallback_total: int) -> int:
    total_text = (content_range or "").rsplit("/", 1)[-1]
    return int(total_text) if total_text.isdigit() else fallback_total

dimension_prefixes_by_name = {"economia": "eco", "pessoas": "pes", "governanca": "gov", "mobilidade": "mob", "ambiente": "amb", "qualidade de vida": "qvi", "infraestrutura digital e dados": "idd"}

def without_accents(text: str) -> str:
    return "".join(character for character in unicodedata.normalize("NFKD", text) if not unicodedata.combining(character))

def dimension_code_prefix(dimension: str) -> str:
    normalized = without_accents(dimension).strip().lower()
    if re.fullmatch(r"[a-z]{3}", normalized):
        return normalized
    if normalized in dimension_prefixes_by_name:
        return dimension_prefixes_by_name[normalized]
    raise HTTPException(422, f"Dimensão desconhecida: {dimension.strip()}. Use a sigla (eco, pes, gov, mob, amb, qvi, idd) ou o nome da dimensão.")

def period_bound(period: str, is_upper_bound: bool) -> str:
    period_match = re.fullmatch(r"([0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?", period.strip())
    if not period_match:
        raise HTTPException(422, "Informe o período como AAAA, AAAA-MM ou AAAA-MM-DD.")
    year = int(period_match.group(1))
    month = int(period_match.group(2)) if period_match.group(2) else (12 if is_upper_bound else 1)
    try:
        day = int(period_match.group(3)) if period_match.group(3) else (calendar.monthrange(year, month)[1] if is_upper_bound else 1)
        return date(year, month, day).isoformat()
    except ValueError:
        raise HTTPException(422, f"O período {period.strip()} não é uma data válida.") from None

@router.get("/dashboard-values")
def list_dashboard_values(indicator_code: str | None = None, dataset_id: str | None = None, limit: int = 200, offset: int = 0, municipality_code: str | None = None, dimension: str | None = None, period_from: str | None = None, period_to: str | None = None, search: str | None = None) -> dict[str, Any]:
    page_limit = max(1, min(limit, 1000))
    page_offset = max(0, offset)
    query_parameters: dict[str, str] = {"select": "id,dataset_id,dataset_name,domain_name,indicator_code,indicator_name,dimensions,reference_period,value,unit,import_title,source_name", "order": "reference_period.desc,id", "limit": str(page_limit), "offset": str(page_offset)}
    if indicator_code:
        query_parameters["indicator_code"] = f"eq.{indicator_code}"
    if dataset_id:
        query_parameters["dataset_id"] = f"eq.{dataset_id}"
    if municipality_code and municipality_code.strip():
        if not re.fullmatch(r"[0-9]{7}", municipality_code.strip()):
            raise HTTPException(422, "Informe um código IBGE de município com sete dígitos.")
        query_parameters["dimensions->>municipality_ibge_code"] = f"eq.{municipality_code.strip()}"
    combined_conditions: list[str] = []
    if dimension and dimension.strip():
        combined_conditions.append(f"indicator_code.like.{dimension_code_prefix(dimension)}*")
    lower_bound = period_bound(period_from, False) if period_from and period_from.strip() else None
    upper_bound = period_bound(period_to, True) if period_to and period_to.strip() else None
    if lower_bound and upper_bound and lower_bound > upper_bound:
        raise HTTPException(422, "O período inicial precisa ser anterior ao período final.")
    if lower_bound:
        combined_conditions.append(f"reference_period.gte.{lower_bound}")
    if upper_bound:
        combined_conditions.append(f"reference_period.lte.{upper_bound}")
    if combined_conditions:
        query_parameters["and"] = f"({','.join(combined_conditions)})"
    search_term = re.sub(r"""[,()*"\\]""", " ", search or "").strip()
    if search_term:
        query_parameters["or"] = f"(indicator_code.ilike.*{search_term}*,indicator_name.ilike.*{search_term}*)"
    values_response = httpx.get(supabase_client.supabase_url("/rest/v1/dashboard_values"), params={**query_parameters, "select": f"{query_parameters['select']},period_granularity"}, headers=supabase_client.supabase_headers("count=exact"), timeout=30.0)
    if values_response.status_code == 400:
        values_response = httpx.get(supabase_client.supabase_url("/rest/v1/dashboard_values"), params=query_parameters, headers=supabase_client.supabase_headers("count=exact"), timeout=30.0)
    if not values_response.is_success:
        raise upstream_error("Não foi possível carregar os dados revisados.", values_response)
    dashboard_values = values_response.json()
    municipality_codes = sorted({code for value in dashboard_values if re.fullmatch(r"[0-9]{7}", code := str((value.get("dimensions") or {}).get("municipality_ibge_code") or ""))})
    municipality_names: dict[str, str] = {}
    if municipality_codes:
        municipalities_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_municipalities"), params={"select": "ibge_code,name,state", "ibge_code": f"in.({','.join(municipality_codes)})"}, headers=supabase_client.supabase_headers(), timeout=30.0)
        if municipalities_response.is_success:
            municipality_names = {record["ibge_code"]: f"{record['name']} ({record['state']})" for record in municipalities_response.json()}
    for value in dashboard_values:
        value["municipality_name"] = municipality_names.get(str((value.get("dimensions") or {}).get("municipality_ibge_code") or ""))
    return {"items": dashboard_values, "total": total_from_content_range(values_response.headers.get("content-range"), page_offset + len(dashboard_values)), "limit": page_limit, "offset": page_offset}

@router.get("/iiu-municipalities")
def search_iiu_municipalities(search: str = "") -> list[dict[str, Any]]:
    query_parameters = {"select": "ibge_code,name,state", "order": "name", "limit": "20"}
    if search.strip():
        query_parameters["or"] = f"(ibge_code.ilike.*{search.strip()}*,name.ilike.*{search.strip()}*)"
    municipalities_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_municipalities"), params=query_parameters, headers=supabase_client.supabase_headers(), timeout=30.0)
    if not municipalities_response.is_success:
        raise HTTPException(502, "Não foi possível carregar os municípios do IIU.")
    return municipalities_response.json()

maturity_levels = ((20, "Nível 1 - Inicial"), (40, "Nível 2 - Em desenvolvimento"), (60, "Nível 3 - Estruturado"), (80, "Nível 4 - Gerenciado"), (100, "Nível 5 - Otimizado"))

def mean_score(scores: list[float]) -> float | None:
    return sum(scores) / len(scores) if scores else None

def weighted_overall_score(weighted_scores: list[tuple[float, float]]) -> float | None:
    return sum(score * weight for score, weight in weighted_scores) / sum(weight for _, weight in weighted_scores) if weighted_scores else None

def maturity_label(overall_score: float | None) -> str | None:
    return next((label for limit, label in maturity_levels if overall_score is not None and overall_score <= limit), None)

def iiu_score(value: float, direction: str, minimum_value: float | None, maximum_value: float | None, checklist_max: float | None) -> float | None:
    if direction == "checklist" and checklist_max:
        return min(100.0, max(0.0, value / checklist_max * 100))
    if minimum_value is None or maximum_value is None or minimum_value >= maximum_value:
        return None
    if direction == "direct":
        return min(100.0, max(0.0, (value - minimum_value) / (maximum_value - minimum_value) * 100))
    if direction == "inverse":
        return min(100.0, max(0.0, (maximum_value - value) / (maximum_value - minimum_value) * 100))
    return None

@router.get("/iiu-dashboard/{municipality_code}")
def get_iiu_dashboard(municipality_code: str, city_profile: str = "medio") -> dict[str, Any]:
    is_demonstration = municipality_code == "demo"
    if not is_demonstration and not re.fullmatch(r"[0-9]{7}", municipality_code):
        raise HTTPException(422, "Informe um código IBGE de município com sete dígitos.")
    if city_profile not in {"pequeno", "medio", "grande", "metropole"}:
        raise HTTPException(422, "Escolha um porte de município válido para o cálculo do IIU.")
    catalog_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_indicator_catalog"), params={"select": "*", "order": "display_order,name"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    dimension_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_dimension_catalog"), params={"city_profile": f"eq.{city_profile}", "select": "*", "order": "display_order"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    benchmark_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_indicator_benchmark_catalog"), params={"city_profile": f"eq.{city_profile}", "select": "*"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    values_response = httpx.get(supabase_client.supabase_url("/rest/v1/dashboard_values"), params={"dimensions->>municipality_ibge_code": f"eq.{municipality_code}", "select": "indicator_code,value,reference_period,unit,source_name,import_title", "order": "reference_period.desc", "limit": "1000"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    if not all(response.is_success for response in (catalog_response, dimension_response, benchmark_response, values_response)):
        raise HTTPException(502, "Não foi possível montar o IIU. Confirme se a migration 0012_iiu_framework.sql foi executada no Supabase.")
    latest_values: dict[str, dict[str, Any]] = {}
    for published_value in values_response.json():
        latest_values.setdefault(published_value["indicator_code"], published_value)
    if is_demonstration:
        catalog_units = {indicator["code"]: indicator["unit"] for indicator in catalog_response.json()}
        latest_values = {indicator_code: {"indicator_code": indicator_code, "value": demonstration_value, "reference_period": "2025-01-01", "unit": catalog_units[indicator_code], "source_name": "Demonstração DECSYS", "import_title": "Valores sintéticos - não oficiais"} for indicator_code in catalog_units for demonstration_value in [iiu_demonstration_values.get(indicator_code.split("_", 1)[0])] if demonstration_value is not None}
    benchmark_by_indicator = {benchmark["indicator_code"]: benchmark for benchmark in benchmark_response.json()}
    indicators_by_dimension: dict[str, list[dict[str, Any]]] = {}
    for indicator in catalog_response.json():
        published_value = latest_values.get(indicator["code"])
        benchmark = benchmark_by_indicator.get(indicator["code"])
        if is_demonstration and benchmark is None and published_value and indicator["score_direction"] != "checklist":
            benchmark = {"minimum_value": published_value["value"] * 0.4, "maximum_value": published_value["value"] * 1.6}
        raw_value = float(published_value["value"]) if published_value and published_value["value"] is not None else None
        score = iiu_score(raw_value, indicator["score_direction"], float(benchmark["minimum_value"]) if benchmark else None, float(benchmark["maximum_value"]) if benchmark else None, float(indicator["checklist_max"]) if indicator["checklist_max"] is not None else None) if raw_value is not None else None
        indicators_by_dimension.setdefault(indicator["iiu_dimension_code"], []).append({"code": indicator["code"], "name": indicator["name"], "type": indicator["iiu_type"], "unit": indicator["unit"], "formula": indicator["formula"], "source": indicator["source_description"], "direction": indicator["score_direction"], "raw_value": raw_value, "reference_period": published_value["reference_period"] if published_value else None, "score": score, "benchmark": {"minimum": float(benchmark["minimum_value"]), "maximum": float(benchmark["maximum_value"])} if benchmark else None})
    dimensions = []
    weighted_scores: list[tuple[float, float]] = []
    for dimension in dimension_response.json():
        dimension_indicators = indicators_by_dimension.get(dimension["code"], [])
        valid_scores = [indicator["score"] for indicator in dimension_indicators if indicator["score"] is not None]
        dimension_score = mean_score(valid_scores)
        if dimension_score is not None:
            weighted_scores.append((dimension_score, float(dimension["weight"])))
        dimensions.append({"code": dimension["code"], "name": dimension["name"], "color": dimension["color"], "weight": float(dimension["weight"]), "score": dimension_score, "indicators": dimension_indicators, "scored_indicators": len(valid_scores), "observed_indicators": sum(1 for indicator in dimension_indicators if indicator["raw_value"] is not None), "total_indicators": len(dimension_indicators)})
    overall_score = weighted_overall_score(weighted_scores)
    return {"municipality_ibge_code": municipality_code, "city_profile": city_profile, "is_demonstration": is_demonstration, "overall_score": overall_score, "maturity": maturity_label(overall_score), "observed_indicators": sum(dimension["observed_indicators"] for dimension in dimensions), "scored_indicators": sum(dimension["scored_indicators"] for dimension in dimensions), "total_indicators": sum(dimension["total_indicators"] for dimension in dimensions), "dimensions": dimensions}
