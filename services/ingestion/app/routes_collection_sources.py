import httpx
import re
from datetime import date, datetime
from fastapi import HTTPException
from typing import Any
from fastapi import APIRouter

from . import supabase_client
from .models import CollectionSourceInput
from .supabase_client import upstream_error

router = APIRouter()


collection_sources_path = "/rest/v1/collection_sources"

collection_sources_missing_message = "Execute a migration 0021_collection_sources.sql no Supabase para salvar fontes de coleta."

collection_text_limits = {"dimension": 80, "factor": 120, "name": 200, "definition": 600, "unit": 80, "source": 200, "steps": 1200, "notes": 1200}

def collection_source_from_row(row: dict[str, Any]) -> dict[str, Any]:
    return {"code": row["code"], "dimension": row["dimension"], "factor": row["factor"], "name": row["name"], "definition": row["definition"], "unit": row["unit"], "source": row["source"], "officialLink": row.get("official_link") or "", "access": row["access"], "importUrl": row.get("import_url") or None, "manualUrl": row.get("manual_url") or None, "steps": row["steps"], "needs": row.get("needs") or [], "notes": row.get("notes") or None, "verifiedOn": row["verified_on"]}

def validated_collection_code(raw_code: str) -> str:
    collection_code = raw_code.strip().upper()
    if not re.fullmatch(r"[A-Z0-9_]{2,30}", collection_code):
        raise HTTPException(422, "O código deve ter de 2 a 30 letras maiúsculas, números ou sublinhados (ex.: ECO11).")
    return collection_code

def collection_source_values(source: CollectionSourceInput, collection_code: str) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for field_name, field_limit in collection_text_limits.items():
        field_value = (getattr(source, field_name) or "").strip()
        if len(field_value) > field_limit:
            raise HTTPException(422, f"O campo {field_name} passa de {field_limit} caracteres.")
        values[field_name] = field_value
    values["dimension"] = values["dimension"] or "Outras"
    values["name"] = values["name"] or collection_code
    for field_name, link_value in (("official_link", source.official_link), ("import_url", source.import_url), ("manual_url", source.manual_url)):
        link_text = (link_value or "").strip()
        if link_text and not (link_text.startswith("https://") and len(link_text) <= 2000 and " " not in link_text):
            raise HTTPException(422, "Os links precisam começar com https:// e não podem ter espaços.")
        values[field_name] = link_text or None
    if source.access != "link":
        values["import_url"] = None
    values["access"] = source.access
    values["needs"] = [need.strip()[:200] for need in source.needs if need.strip()][:10]
    values["notes"] = values["notes"] or None
    return values

@router.get("/collection-sources")
def list_collection_sources() -> list[dict[str, Any]]:
    sources_response = httpx.get(supabase_client.supabase_url(collection_sources_path), params={"select": "*", "order": "code"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    if sources_response.status_code == 404:
        raise HTTPException(503, collection_sources_missing_message)
    if not sources_response.is_success:
        raise upstream_error("Não foi possível carregar as fontes de coleta.", sources_response)
    return [collection_source_from_row(row) for row in sources_response.json()]

@router.put("/collection-sources/{code}")
def save_collection_source(code: str, source: CollectionSourceInput) -> dict[str, Any]:
    collection_code = validated_collection_code(code)
    row_values = {"code": collection_code, **collection_source_values(source, collection_code), "verified_on": date.today().isoformat(), "updated_at": datetime.now().astimezone().isoformat()}
    save_response = httpx.post(supabase_client.supabase_url(collection_sources_path), params={"on_conflict": "code"}, headers=supabase_client.supabase_headers("resolution=merge-duplicates,return=representation"), json=row_values, timeout=30.0)
    if save_response.status_code == 404:
        raise HTTPException(503, collection_sources_missing_message)
    if not save_response.is_success:
        raise upstream_error("Não foi possível salvar a fonte de coleta.", save_response)
    return collection_source_from_row(save_response.json()[0])

@router.delete("/collection-sources/{code}")
def delete_collection_source(code: str) -> dict[str, str]:
    collection_code = validated_collection_code(code)
    delete_response = httpx.delete(supabase_client.supabase_url(collection_sources_path), params={"code": f"eq.{collection_code}"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    if delete_response.status_code == 404:
        raise HTTPException(503, collection_sources_missing_message)
    if not delete_response.is_success:
        raise upstream_error("Não foi possível excluir a fonte de coleta.", delete_response)
    return {"code": collection_code, "status": "deleted"}
