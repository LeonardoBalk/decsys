import httpx
import math
import re
from fastapi import HTTPException
from typing import Any
from fastapi import APIRouter

from . import supabase_client
from .models import IndicatorRegistration, IndicatorUpdate
from .supabase_client import indicator_registry_path, registry_error, upstream_error
from .table_reading import normalize_column

router = APIRouter()


indicator_fields = "id,code,name,dimension,definition,unit,expected_frequency,active,calculation_type,calculation_multiplier,iiu_enabled,iiu_dimension_code,iiu_type,source_description,score_direction,checklist_max"

@router.get("/indicators")
def list_indicators() -> list[dict[str, Any]]:
    indicators_response = httpx.get(supabase_client.supabase_url(indicator_registry_path), params={"select": indicator_fields, "active": "is.true", "order": "name"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    if indicators_response.is_success:
        return indicators_response.json()
    fallback_response = httpx.post(supabase_client.supabase_url("/rest/v1/rpc/list_active_indicators"), headers=supabase_client.supabase_headers(), json={}, timeout=30.0)
    if not fallback_response.is_success:
        raise upstream_error("Não foi possível carregar os indicadores.", fallback_response)
    return fallback_response.json()

@router.get("/indicators/{indicator_id}")
def get_indicator(indicator_id: str) -> dict[str, Any]:
    indicator_response = httpx.get(supabase_client.supabase_url(indicator_registry_path), params={"select": indicator_fields, "id": f"eq.{indicator_id}"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    if not indicator_response.is_success:
        raise registry_error("Não foi possível carregar o indicador.", indicator_response)
    if not indicator_response.json():
        raise HTTPException(404, "Indicador não encontrado.")
    return indicator_response.json()[0]

@router.patch("/indicators/{indicator_id}")
def update_indicator(indicator_id: str, indicator: IndicatorUpdate) -> dict[str, Any]:
    indicator_values = {"name": indicator.name.strip(), "dimension": indicator.dimension.strip(), "definition": indicator.definition.strip(), "unit": indicator.unit.strip(), "expected_frequency": indicator.expected_frequency.strip() if indicator.expected_frequency else None, "calculation_type": indicator.calculation_type, "calculation_multiplier": indicator.calculation_multiplier, "iiu_enabled": indicator.iiu_enabled, "iiu_dimension_code": indicator.iiu_dimension_code if indicator.iiu_enabled else None, "score_direction": indicator.score_direction if indicator.iiu_enabled else None, "checklist_max": indicator.checklist_max if indicator.iiu_enabled and indicator.score_direction == "checklist" else None}
    if not 0 < indicator.calculation_multiplier <= 1000000:
        raise HTTPException(422, "O multiplicador precisa ser maior que zero e menor ou igual a 1.000.000.")
    validate_indicator_iiu_configuration(indicator.iiu_enabled, indicator.iiu_dimension_code, indicator.score_direction, indicator.checklist_max)
    if not all(indicator_values[field_name] for field_name in ("name", "dimension", "definition", "unit")):
        raise HTTPException(422, "Preencha nome, dimensão, definição e unidade.")
    indicator_response = httpx.patch(supabase_client.supabase_url(indicator_registry_path), params={"id": f"eq.{indicator_id}"}, headers=supabase_client.supabase_headers("return=representation"), json=indicator_values, timeout=30.0)
    if not indicator_response.is_success:
        raise registry_error("Não foi possível atualizar o indicador.", indicator_response)
    if not indicator_response.json():
        raise HTTPException(404, "Indicador não encontrado.")
    return indicator_response.json()[0]

@router.post("/indicators/{indicator_id}/deactivate")
def deactivate_indicator(indicator_id: str) -> dict[str, Any]:
    indicator_response = httpx.patch(supabase_client.supabase_url(indicator_registry_path), params={"id": f"eq.{indicator_id}"}, headers=supabase_client.supabase_headers("return=representation"), json={"active": False}, timeout=30.0)
    if not indicator_response.is_success:
        raise registry_error("Não foi possível desativar o indicador.", indicator_response)
    if not indicator_response.json():
        raise HTTPException(404, "Indicador não encontrado.")
    return indicator_response.json()[0]

@router.get("/indicator-dimensions")
def list_indicator_dimensions() -> list[str]:
    dimension_names: list[str] = []
    dimension_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_dimension_catalog"), params={"select": "name,display_order", "city_profile": "eq.medio", "order": "display_order"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    if dimension_response.is_success:
        dimension_names.extend(str(record["name"]) for record in dimension_response.json())
    indicators_response = httpx.get(supabase_client.supabase_url(indicator_registry_path), params={"select": "dimension"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    if indicators_response.is_success:
        dimension_names.extend(str(record["dimension"]) for record in indicators_response.json() if record.get("dimension"))
    return list(dict.fromkeys(name.strip() for name in dimension_names if name.strip()))

def validate_indicator_iiu_configuration(iiu_enabled: bool, dimension_code: str | None, score_direction: str | None, checklist_maximum: float | None) -> None:
    if not iiu_enabled:
        return
    if not dimension_code or score_direction not in {"direct", "inverse", "checklist"}:
        raise HTTPException(422, "Para incluir o indicador no IIU, escolha a dimensão e como o score deve ser interpretado.")
    if score_direction == "checklist" and (checklist_maximum is None or not math.isfinite(checklist_maximum) or checklist_maximum <= 0):
        raise HTTPException(422, "Informe a pontuação máxima para indicadores do tipo checklist.")
    if score_direction != "checklist" and checklist_maximum is not None:
        raise HTTPException(422, "A pontuação máxima só se aplica a indicadores do tipo checklist.")
    dimension_response = httpx.get(supabase_client.supabase_url("/rest/v1/iiu_dimension_catalog"), params={"select": "code", "city_profile": "eq.medio"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    if not dimension_response.is_success or dimension_code not in {dimension["code"] for dimension in dimension_response.json()}:
        raise HTTPException(422, "Escolha uma dimensão existente no catálogo do IIU.")

@router.post("/indicators")
def create_indicator(indicator: IndicatorRegistration) -> dict[str, Any]:
    indicator_code = normalize_column(indicator.code)
    if not re.fullmatch(r"[a-z][a-z0-9_]{2,99}", indicator_code):
        raise HTTPException(422, "O código deve ter letras minúsculas, números ou sublinhados e começar com uma letra.")
    if not math.isfinite(indicator.calculation_multiplier) or not 0 < indicator.calculation_multiplier <= 1000000:
        raise HTTPException(422, "O multiplicador precisa ser maior que zero e menor ou igual a 1.000.000.")
    validate_indicator_iiu_configuration(indicator.iiu_enabled, indicator.iiu_dimension_code, indicator.score_direction, indicator.checklist_max)
    indicator_response = httpx.post(supabase_client.supabase_url(indicator_registry_path), headers=supabase_client.supabase_headers("return=representation"), json={"code": indicator_code, "name": indicator.name.strip(), "dimension": indicator.dimension.strip(), "definition": indicator.definition.strip(), "unit": indicator.unit.strip(), "expected_frequency": indicator.expected_frequency.strip() if indicator.expected_frequency else None, "calculation_type": indicator.calculation_type, "calculation_multiplier": indicator.calculation_multiplier, "iiu_enabled": indicator.iiu_enabled, "iiu_dimension_code": indicator.iiu_dimension_code if indicator.iiu_enabled else None, "score_direction": indicator.score_direction if indicator.iiu_enabled else None, "checklist_max": indicator.checklist_max if indicator.iiu_enabled and indicator.score_direction == "checklist" else None}, timeout=30.0)
    if indicator_response.status_code == 409:
        raise HTTPException(409, "Já existe um indicador com esse código.")
    if not indicator_response.is_success:
        raise registry_error("Não foi possível cadastrar o indicador no Supabase.", indicator_response)
    return indicator_response.json()[0]
