import hmac
import httpx
import os
from fastapi import HTTPException, Header
from fastapi import APIRouter

from . import supabase_client

router = APIRouter()


@router.get("/keepalive")
def keepalive(authorization: str | None = Header(default=None)) -> dict[str, str]:
    keepalive_secret = os.getenv("KEEPALIVE_SECRET")
    if not keepalive_secret:
        raise HTTPException(503, "O monitoramento do banco ainda não foi configurado.")
    expected_authorization = f"Bearer {keepalive_secret}".encode("utf-8")
    provided_authorization = (authorization or "").encode("utf-8")
    if not hmac.compare_digest(provided_authorization, expected_authorization):
        raise HTTPException(401, "Não autorizado.")
    try:
        database_response = httpx.get(
            supabase_client.supabase_url("/rest/v1/imports"),
            params={"select": "id", "limit": "1"},
            headers=supabase_client.supabase_headers(),
            timeout=10.0,
        )
    except httpx.TransportError:
        raise HTTPException(503, "Não foi possível consultar o banco de dados.")
    if not database_response.is_success:
        raise HTTPException(503, "Não foi possível consultar o banco de dados.")
    return {"status": "ok", "database": "reachable"}

@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
