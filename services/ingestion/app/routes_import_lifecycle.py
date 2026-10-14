import httpx
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from typing import Any
from urllib.parse import quote
from uuid import UUID

from . import supabase_client
from .routes_iiu import total_from_content_range
from .supabase_client import upstream_error

router = APIRouter()


lifecycle_missing_message = "Execute a migration 0027_import_lifecycle.sql no Supabase para desfazer aprovações e excluir importações."

def fetch_import_record(import_id: str) -> dict[str, Any]:
    try:
        UUID(import_id)
    except ValueError:
        raise HTTPException(404, "Importação não encontrada.") from None
    import_response = httpx.get(supabase_client.supabase_url("/rest/v1/imports"), params={"id": f"eq.{import_id}", "select": "id,title,status,storage_path,total_rows"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    if not import_response.is_success:
        raise upstream_error("Não foi possível carregar a importação.", import_response)
    import_records = import_response.json()
    if not import_records:
        raise HTTPException(404, "Importação não encontrada.")
    return import_records[0]

def exact_row_count(table_path: str, import_id: str) -> int:
    count_response = httpx.get(supabase_client.supabase_url(table_path), params={"import_id": f"eq.{import_id}", "select": "id", "limit": "1"}, headers=supabase_client.supabase_headers("count=exact"), timeout=60.0)
    if not count_response.is_success:
        raise upstream_error("Não foi possível calcular o impacto desta importação.", count_response)
    return total_from_content_range(count_response.headers.get("content-range"), len(count_response.json()))

@router.get("/imports/{import_id}/impact")
def get_import_impact(import_id: str) -> dict[str, Any]:
    record = fetch_import_record(import_id)
    return {
        "import_id": import_id,
        "title": record["title"],
        "status": record["status"],
        "has_file": bool(record.get("storage_path")),
        "published_values": exact_row_count("/rest/v1/dashboard_values", import_id),
        "import_rows": exact_row_count("/rest/v1/import_rows", import_id),
        "import_sheets": exact_row_count("/rest/v1/import_sheets", import_id),
        "validation_issues": exact_row_count("/rest/v1/validation_issues", import_id),
    }

@router.post("/imports/{import_id}/unapprove")
def unapprove_import(import_id: str) -> dict[str, Any]:
    record = fetch_import_record(import_id)
    if record["status"] != "approved":
        raise HTTPException(409, "Só importações aprovadas podem ter a aprovação desfeita.")
    try:
        unapprove_response = httpx.post(supabase_client.supabase_url("/rest/v1/rpc/unapprove_import"), headers=supabase_client.supabase_headers(), json={"selected_import_id": import_id}, timeout=300.0)
    except httpx.TransportError:
        raise HTTPException(504, "O Supabase demorou demais para responder. Atualize a lista: a aprovação pode já ter sido desfeita.") from None
    if unapprove_response.status_code == 404:
        raise HTTPException(503, lifecycle_missing_message)
    if not unapprove_response.is_success:
        raise upstream_error("Não foi possível desfazer a aprovação.", unapprove_response)
    return unapprove_response.json()

@router.post("/imports/{import_id}/archive")
def archive_import(import_id: str) -> dict[str, str]:
    record = fetch_import_record(import_id)
    if record["status"] == "discarded":
        raise HTTPException(409, "Importações descartadas não podem ser arquivadas.")
    if record["status"] != "archived":
        archive_response = httpx.patch(supabase_client.supabase_url("/rest/v1/imports"), params={"id": f"eq.{import_id}"}, headers=supabase_client.supabase_headers("return=minimal"), json={"status": "archived", "archived_at": datetime.now(timezone.utc).isoformat()}, timeout=30.0)
        if not archive_response.is_success:
            raise upstream_error("Não foi possível arquivar a importação.", archive_response)
    return {"import_id": import_id, "status": "archived"}

def remove_stored_file(storage_path: str | None) -> bool:
    if not storage_path:
        return True
    try:
        storage_response = httpx.delete(supabase_client.supabase_url(f"/storage/v1/object/source-files/{quote(storage_path, safe='/')}"), headers=supabase_client.supabase_headers(), timeout=30.0)
    except httpx.TransportError:
        return False
    return storage_response.is_success or storage_response.status_code == 404

@router.delete("/imports/{import_id}")
def delete_import(import_id: str, force: bool = False) -> dict[str, Any]:
    record = fetch_import_record(import_id)
    if record["status"] == "approved" and not force:
        raise HTTPException(409, "Esta importação está aprovada e alimenta o painel. Desfaça a aprovação antes de excluir ou confirme a exclusão forçada.")
    try:
        delete_response = httpx.post(supabase_client.supabase_url("/rest/v1/rpc/delete_import_cascade"), headers=supabase_client.supabase_headers(), json={"selected_import_id": import_id}, timeout=600.0)
    except httpx.TransportError:
        raise HTTPException(504, "O Supabase demorou demais para responder. Atualize a lista: a exclusão pode ter terminado; se a importação ainda aparecer, nada foi apagado.") from None
    if delete_response.status_code == 404:
        raise HTTPException(503, lifecycle_missing_message)
    if not delete_response.is_success:
        raise upstream_error("Não foi possível excluir a importação.", delete_response)
    storage_removed = remove_stored_file(record.get("storage_path"))
    return {"import_id": import_id, "status": "deleted", "deleted": delete_response.json(), "storage_removed": storage_removed}
