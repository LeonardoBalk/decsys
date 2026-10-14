import httpx
from fastapi import APIRouter, HTTPException
from typing import Any

from . import supabase_client
from .supabase_client import upstream_error

router = APIRouter()


coverage_missing_message = "Execute a migration 0028_indicator_coverage.sql no Supabase para mostrar quais indicadores já têm dados."

coverage_fields = "indicator_code,municipalities,value_count,first_reference_period,last_reference_period"

@router.get("/collection-coverage")
def list_collection_coverage() -> list[dict[str, Any]]:
    coverage_response = httpx.get(supabase_client.supabase_url("/rest/v1/indicator_coverage"), params={"select": coverage_fields, "order": "indicator_code", "limit": "1000"}, headers=supabase_client.supabase_headers(), timeout=60.0)
    if coverage_response.status_code == 404:
        raise HTTPException(503, coverage_missing_message)
    if not coverage_response.is_success:
        raise upstream_error("Não foi possível carregar a cobertura de dados dos indicadores.", coverage_response)
    return [{"indicator_code": row["indicator_code"], "municipalities": int(row["municipalities"] or 0), "value_count": int(row["value_count"] or 0), "first_period": row.get("first_reference_period"), "last_period": row.get("last_reference_period")} for row in coverage_response.json()]
