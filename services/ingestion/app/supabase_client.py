import os
from fastapi import HTTPException
from typing import Any


def supabase_error_detail(response: Any) -> str:
    try:
        payload = response.json()
    except ValueError:
        return ""
    if isinstance(payload, dict):
        return str(payload.get("message") or payload.get("error") or "").strip()
    return ""

def upstream_error(message: str, response: Any) -> HTTPException:
    detail = supabase_error_detail(response)
    return HTTPException(502, f"{message} Detalhe: {detail}" if detail else message)

def supabase_headers(prefer: str | None = None, profile: str | None = None) -> dict[str, str]:
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not service_role_key:
        raise HTTPException(500, "Configure SUPABASE_SERVICE_ROLE_KEY no serviço de ingestão.")
    request_headers = {"apikey": service_role_key, "Authorization": f"Bearer {service_role_key}"}
    if prefer:
        request_headers["Prefer"] = prefer
    if profile:
        request_headers["Accept-Profile"] = profile
    return request_headers

def supabase_url(path: str) -> str:
    project_url = os.getenv("SUPABASE_URL")
    if not project_url:
        raise HTTPException(500, "Configure SUPABASE_URL no serviço de ingestão.")
    return f"{project_url}{path}"

indicator_registry_path = "/rest/v1/indicator_registry"

missing_registry_message = "Execute a migration 0014_public_indicator_registry.sql no Supabase para cadastrar e editar indicadores."

def registry_error(message: str, response: Any) -> HTTPException:
    if response.status_code == 404:
        return HTTPException(503, missing_registry_message)
    return upstream_error(message, response)
