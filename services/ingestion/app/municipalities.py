import httpx
import re
import time
import unicodedata
from fastapi import HTTPException
from typing import Any
from fastapi import APIRouter

from . import import_store, supabase_client
from .config import ibge_catalog_ttl_seconds
from .models import MunicipalityResolution
from .periods import cell_text
from .supabase_client import upstream_error

router = APIRouter()


ibge_catalog_cache: dict[str, Any] = {"expires_at": 0.0, "catalog": []}

def ibge_municipality_catalog() -> list[dict[str, str]]:
    if ibge_catalog_cache["expires_at"] > time.time() and ibge_catalog_cache["catalog"]:
        return ibge_catalog_cache["catalog"]
    municipality_catalog = fetch_ibge_municipalities()
    ibge_catalog_cache.update({"expires_at": time.time() + ibge_catalog_ttl_seconds, "catalog": municipality_catalog})
    return municipality_catalog

municipal_catalog_registration: dict[str, float] = {"registered_until": 0.0}

def ensure_municipal_catalog_registered() -> None:
    if municipal_catalog_registration["registered_until"] > time.time():
        return
    municipality_catalog = ibge_municipality_catalog()
    for start_index in range(0, len(municipality_catalog), 1000):
        try:
            registration_response = httpx.post(supabase_client.supabase_url("/rest/v1/rpc/register_municipalities"), headers=supabase_client.supabase_headers(), json={"selected_municipalities": municipality_catalog[start_index:start_index + 1000]}, timeout=60.0)
        except httpx.TransportError:
            raise HTTPException(502, "Não foi possível acessar o Supabase para cadastrar os municípios do IBGE.")
        if registration_response.status_code == 404:
            raise HTTPException(503, "Execute a migration 0014_public_indicator_registry.sql no Supabase para cadastrar os municípios do IBGE.")
        if not registration_response.is_success:
            raise upstream_error("Não foi possível cadastrar os municípios do IBGE no Supabase.", registration_response)
    municipal_catalog_registration["registered_until"] = time.time() + ibge_catalog_ttl_seconds

def municipality_code_resolver(municipality_catalog: list[dict[str, str]]):
    known_codes = {municipality["ibge_code"] for municipality in municipality_catalog}
    codes_by_prefix: dict[str, list[str]] = {}
    for ibge_code in known_codes:
        codes_by_prefix.setdefault(ibge_code[:6], []).append(ibge_code)

    def resolve(cell_value: Any) -> str | None:
        code_text = re.sub(r"\.0+$", "", cell_text(cell_value))
        if re.fullmatch(r"[0-9]{7}", code_text):
            return code_text if code_text in known_codes else None
        if re.fullmatch(r"[0-9]{6}", code_text):
            prefix_matches = codes_by_prefix.get(code_text, [])
            return prefix_matches[0] if len(prefix_matches) == 1 else None
        return None

    return resolve

def municipality_indexes(municipality_catalog: list[dict[str, str]]) -> tuple[dict[tuple[str, str], list[dict[str, str]]], dict[str, list[dict[str, str]]]]:
    by_name_and_state: dict[tuple[str, str], list[dict[str, str]]] = {}
    by_name: dict[str, list[dict[str, str]]] = {}
    for municipality in municipality_catalog:
        normalized_name = normalize_municipality_name(municipality["name"])
        by_name_and_state.setdefault((normalized_name, municipality["state"]), []).append(municipality)
        by_name.setdefault(normalized_name, []).append(municipality)
    return by_name_and_state, by_name

def municipality_candidates(original_name: str, indexes: tuple[dict[tuple[str, str], list[dict[str, str]]], dict[str, list[dict[str, str]]]]) -> tuple[str, list[dict[str, str]]]:
    by_name_and_state, by_name = indexes
    parsed_name = parse_municipality_name(original_name)
    if parsed_name:
        candidates = by_name_and_state.get((normalize_municipality_name(parsed_name[0]), parsed_name[1]), [])
        return ("matched" if len(candidates) == 1 else "ambiguous" if candidates else "unmatched"), candidates
    code_text = re.sub(r"\.0+$", "", original_name.strip())
    if re.fullmatch(r"[0-9]{6,7}", code_text):
        candidates = [municipality for municipalities in by_name.values() for municipality in municipalities if municipality["ibge_code"] == code_text or (len(code_text) == 6 and municipality["ibge_code"][:6] == code_text)]
        return ("matched" if len(candidates) == 1 else "unmatched"), candidates[:1]
    candidates = by_name.get(normalize_municipality_name(original_name), []) if original_name else []
    return ("ambiguous" if candidates else "unmatched"), candidates

@router.post("/imports/{import_id}/municipality-matches")
def suggest_municipality_matches(import_id: str, resolution: MunicipalityResolution) -> dict[str, Any]:
    indexes = municipality_indexes(ibge_municipality_catalog())
    municipality_rows = fetch_rows_for_municipality_resolution(import_id, resolution.sheet_name)
    matches = []
    for municipality_row in municipality_rows:
        original_name = str(municipality_row["raw_row"].get(resolution.municipality_field) or "").strip()
        match_status, candidates = municipality_candidates(original_name, indexes)
        matches.append({
            "row_number": municipality_row["row_number"],
            "original_name": original_name,
            "status": match_status,
            "suggestion": candidates[0] if match_status == "matched" else None,
            "candidates": candidates if match_status == "ambiguous" else [],
        })
    return {"import_id": import_id, "sheet_name": resolution.sheet_name, "matches": matches, "matched_count": sum(match["status"] == "matched" for match in matches)}

@router.post("/imports/{import_id}/apply-municipality-matches")
def apply_municipality_matches(import_id: str, resolution: MunicipalityResolution) -> dict[str, Any]:
    if not resolution.matches:
        raise HTTPException(422, "Selecione ao menos uma correspondência para aplicar.")
    municipality_list = ibge_municipality_catalog()
    municipality_catalog = {municipality["ibge_code"]: municipality for municipality in municipality_list}
    requested_codes = {match.ibge_code for match in resolution.matches}
    if any(ibge_code not in municipality_catalog for ibge_code in requested_codes):
        raise HTTPException(422, "Um dos códigos escolhidos não existe no catálogo oficial do IBGE. Confira o código digitado e tente novamente.")
    municipality_rows = fetch_rows_for_municipality_resolution(import_id, resolution.sheet_name)
    rows_by_number = {row["row_number"]: row for row in municipality_rows}
    if any(match.row_number not in rows_by_number for match in resolution.matches):
        raise HTTPException(422, "Uma ou mais linhas selecionadas não pertencem a esta aba. Atualize as sugestões e tente novamente.")
    if len({match.row_number for match in resolution.matches}) != len(resolution.matches):
        raise HTTPException(422, "Uma linha foi enviada mais de uma vez. Atualize as sugestões e tente novamente.")
    indexes = municipality_indexes(municipality_list)
    for row_match in resolution.matches:
        if row_match.origin == "manual":
            continue
        original_name = str(rows_by_number[row_match.row_number]["raw_row"].get(resolution.municipality_field) or "").strip()
        match_status, candidates = municipality_candidates(original_name, indexes)
        candidate_codes = [candidate["ibge_code"] for candidate in candidates]
        is_confirmed = match_status == "matched" and candidate_codes == [row_match.ibge_code] if row_match.origin == "exact" else row_match.ibge_code in candidate_codes
        if not is_confirmed:
            raise HTTPException(422, f"A correspondência informada para a linha {row_match.row_number} não confere com o nome consultado no IBGE.")
    confirmed_municipalities = [municipality_catalog[ibge_code] for ibge_code in sorted(requested_codes)]
    try:
        municipality_response = httpx.post(
            supabase_client.supabase_url("/rest/v1/rpc/register_municipalities"),
            headers=supabase_client.supabase_headers(),
            json={"selected_municipalities": [{"ibge_code": municipality["ibge_code"], "name": municipality["name"], "state": municipality["state"]} for municipality in confirmed_municipalities]},
            timeout=30.0,
        )
    except httpx.TransportError:
        raise HTTPException(502, "Não foi possível acessar o Supabase para registrar os municípios confirmados.")
    if municipality_response.status_code == 404:
        raise HTTPException(503, "Execute a migration 0014_public_indicator_registry.sql no Supabase para registrar os municípios confirmados.")
    if not municipality_response.is_success:
        raise upstream_error("Os códigos foram conferidos no IBGE, mas não foi possível atualizar o cadastro municipal do Supabase.", municipality_response)
    updated_rows = [
        (rows_by_number[row_match.row_number], {**(rows_by_number[row_match.row_number].get("normalized_row") or {}), "municipality_ibge_code": row_match.ibge_code, "municipality_code_source": "ibge_lookup"})
        for row_match in resolution.matches
    ]
    confirmed_row_numbers = {row_match.row_number for row_match in resolution.matches}
    for staged_row in municipality_rows:
        previous_row = staged_row.get("normalized_row") or {}
        if staged_row["row_number"] not in confirmed_row_numbers and previous_row.get("municipality_code_source") == "ibge_lookup":
            updated_rows.append((staged_row, {key: value for key, value in previous_row.items() if key not in {"municipality_ibge_code", "municipality_code_source"}}))
    import_store.upsert_staged_rows(import_id, resolution.sheet_name, updated_rows, "Alguns códigos foram preparados, mas não conseguimos salvar todas as correspondências. Tente aplicar novamente.")
    return {"import_id": import_id, "applied_count": len(resolution.matches), "municipality_field": "municipality_ibge_code"}

@router.get("/ibge-municipalities")
def search_ibge_municipalities(search: str = "", limit: int = 20) -> list[dict[str, str]]:
    search_text = search.strip()
    page_limit = max(1, min(limit, 50))
    if search_text.isdigit():
        return [municipality for municipality in ibge_municipality_catalog() if municipality["ibge_code"].startswith(search_text)][:page_limit]
    parsed_name = parse_municipality_name(search_text)
    name_text, state = parsed_name if parsed_name else (search_text, None)
    normalized_search = normalize_municipality_name(name_text)
    if len(normalized_search) < 2:
        return []
    candidates = [municipality for municipality in ibge_municipality_catalog() if (state is None or municipality["state"] == state) and normalized_search in normalize_municipality_name(municipality["name"])]
    candidates.sort(key=lambda municipality: (not normalize_municipality_name(municipality["name"]).startswith(normalized_search), municipality["name"], municipality["state"]))
    return candidates[:page_limit]

def fetch_ibge_municipalities() -> list[dict[str, str]]:
    try:
        catalog_response = httpx.get("https://servicodados.ibge.gov.br/api/v1/localidades/municipios", timeout=30.0)
    except httpx.TransportError:
        raise HTTPException(502, "Não foi possível consultar o catálogo de municípios do IBGE. Tente novamente em alguns instantes.")
    if not catalog_response.is_success:
        raise HTTPException(502, "O serviço de localidades do IBGE está indisponível no momento.")
    try:
        catalog_records = catalog_response.json()
        municipality_catalog = []
        for record in catalog_records:
            municipality_region = record.get("microrregiao") or record.get("regiao-imediata")
            state_region = municipality_region.get("mesorregiao") or municipality_region.get("regiao-intermediaria")
            municipality_catalog.append({"ibge_code": str(record["id"]).zfill(7), "name": record["nome"], "state": state_region["UF"]["sigla"]})
        return municipality_catalog
    except (AttributeError, KeyError, TypeError, ValueError):
        raise HTTPException(502, "O IBGE retornou uma resposta que não conseguimos interpretar. Tente novamente mais tarde.")

def fetch_rows_for_municipality_resolution(import_id: str, sheet_name: str | None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    page_size = 1000
    page_offset = 0
    while True:
        query_params = {"import_id": f"eq.{import_id}", "select": "id,sheet_name,row_number,raw_row,normalized_row", "order": "row_number.asc", "limit": str(page_size), "offset": str(page_offset)}
        if sheet_name is not None:
            query_params["sheet_name"] = f"eq.{sheet_name}"
        try:
            rows_response = httpx.get(supabase_client.supabase_url("/rest/v1/import_rows"), params=query_params, headers=supabase_client.supabase_headers(), timeout=30.0)
        except httpx.TransportError:
            raise HTTPException(502, "Não foi possível acessar o Supabase para carregar as linhas da importação.")
        if not rows_response.is_success:
            raise HTTPException(502, "Não foi possível carregar as linhas para localizar os códigos municipais.")
        current_page = rows_response.json()
        rows.extend(current_page)
        if len(current_page) < page_size:
            return rows
        page_offset += page_size

brazilian_states = {"AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"}

def parse_municipality_name(municipality_name: str) -> tuple[str, str] | None:
    patterns = [
        (r"\s*(.+?)\s*\(([A-Za-z]{2})\)\s*", 1, 2),
        (r"\s*([A-Za-z]{2})\s*-\s*(.+?)\s*", 2, 1),
        (r"\s*(.+?)\s*[-/]\s*([A-Za-z]{2})\s*", 1, 2),
    ]
    for pattern, name_group, state_group in patterns:
        parsed_name = re.fullmatch(pattern, municipality_name)
        if parsed_name and parsed_name.group(state_group).upper() in brazilian_states:
            return parsed_name.group(name_group).strip(), parsed_name.group(state_group).upper()
    return None

def normalize_municipality_name(municipality_name: str) -> str:
    unaccented_name = "".join(character for character in unicodedata.normalize("NFKD", municipality_name.casefold()) if not unicodedata.combining(character))
    return " ".join(re.sub(r"[^a-z0-9]+", " ", unaccented_name).split())
