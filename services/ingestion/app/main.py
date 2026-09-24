import gzip
import hmac
import ipaddress
import json
import os
import re
import socket
import csv
import threading
import time
import unicodedata
import uuid
import zipfile
from decimal import Decimal, InvalidOperation
from hashlib import sha256
from email.message import Message
from io import BytesIO, StringIO
from pathlib import Path
from typing import Any, Literal
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlparse, urlunparse

import httpx
import polars as pl
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from openpyxl import Workbook, load_workbook
from openai import OpenAI
from pydantic import BaseModel, Field, HttpUrl
from starlette.concurrency import run_in_threadpool

load_dotenv(Path(__file__).parents[1] / ".env")

app = FastAPI(title="Decsys Ingestion API", version="0.2.0")
ai_assessment_size_limit = 20 * 1024 * 1024
ai_assessment_timeout = 10.0
ai_unavailable_until = 0.0
supported_extensions = {".csv", ".xlsx", ".xls", ".json"}
archive_extensions = {".zip", ".gz"}
acceptable_extensions = supported_extensions | archive_extensions
maximum_redirect_hops = 5
maximum_source_bytes = int(os.getenv("MAX_SOURCE_MB", "200")) * 1024 * 1024
source_cache_ttl_seconds = 2 * 60 * 60
source_cache_max_bytes = int(os.getenv("SOURCE_CACHE_MB", "1024")) * 1024 * 1024
source_cache: dict[str, dict[str, Any]] = {}
source_cache_lock = threading.Lock()
ibge_catalog_ttl_seconds = 24 * 60 * 60
ibge_catalog_cache: dict[str, Any] = {"expires_at": 0.0, "catalog": []}
iiu_demonstration_values = {
    "cobertura_do_transporte_publico": (65.0, "% população"), "tempo_medio_de_deslocamento": (42.0, "min/dia"),
    "emissao_de_co2_per_capita": (3.2, "tCO₂/hab./ano"), "indice_de_perdas_hidricas": (32.0, "% do volume"), "participacao_de_energias_renovaveis": (47.0, "% da matriz local"),
    "cobertura_da_atencao_basica_esf": (77.0, "% da população"), "cobertura_vacinal": (91.0, "% do público-alvo"), "taxa_de_mortalidade_infantil": (10.0, "por 1.000 NV"),
    "taxa_de_homicidios": (13.0, "por 100k hab."), "taxa_de_roubos_e_furtos": (800.0, "por 100k hab."),
    "cumprimento_da_lai": (8.0, "pontuação 0–10"), "digitalizacao_dos_servicos_publicos": (60.0, "% serviços online"),
    "cobertura_de_banda_larga": (75.0, "% domicílios"), "pib_per_capita_municipal": (48500.0, "R$/hab./ano"), "taxa_de_formalizacao_do_emprego": (64.0, "% trabalhadores formais"),
    "cobertura_de_agua_tratada": (91.0, "% da população"), "cobertura_de_esgoto_sanitario": (75.0, "% da população"), "deficit_habitacional": (6.0, "% dos domicílios"), "populacao_em_area_de_risco": (2.5, "% da população"),
}


class LinkRequest(BaseModel):
    source_url: HttpUrl
    dataset_id: str | None = None
    title: str | None = None
    reference_year: int | None = None
    sheet_name: str | None = None
    include_all_sheets: bool = False
    upload_token: str | None = None


class ImportDecision(BaseModel):
    decision: str


class PeriodSelection(BaseModel):
    mode: Literal["year_column", "date_column", "month_year_columns", "fixed", "prepared"]
    granularity: Literal["year", "month"] = "year"
    year_field: str | None = None
    month_field: str | None = None
    date_field: str | None = None
    fixed_year: int | None = None
    fixed_month: int | None = None


class MunicipalApproval(BaseModel):
    indicator_id: str
    municipality_field: str
    year_field: str | None = None
    value_field: str
    unit: str
    sheet_name: str | None = None
    period: PeriodSelection | None = None


class WideMunicipalTransform(BaseModel):
    municipality_field: str
    value_field: str
    sheet_name: str | None = None


class MunicipalityMatch(BaseModel):
    row_number: int
    ibge_code: str
    origin: Literal["exact", "candidate", "manual"] = "exact"


class MunicipalityResolution(BaseModel):
    municipality_field: str
    sheet_name: str | None = None
    matches: list[MunicipalityMatch] = Field(default_factory=list)


class GenericApproval(BaseModel):
    mapping: dict[str, Any]
    explanation: str


class IndicatorRegistration(BaseModel):
    code: str
    name: str
    dimension: str
    definition: str
    unit: str
    expected_frequency: str | None = None


class IndicatorUpdate(BaseModel):
    name: str
    dimension: str
    definition: str
    unit: str
    expected_frequency: str | None = None


def source_too_large_error() -> HTTPException:
    return HTTPException(413, f"O arquivo passa do limite de {maximum_source_bytes // (1024 * 1024)} MB. Divida a planilha em arquivos menores e tente novamente.")


def ensure_source_size(byte_count: int) -> None:
    if byte_count > maximum_source_bytes:
        raise source_too_large_error()


async def read_upload(file: UploadFile) -> bytes:
    source_content = await file.read(maximum_source_bytes + 1)
    ensure_source_size(len(source_content))
    return source_content


def bounded_gzip_decompress(source_content: bytes) -> bytes:
    with gzip.GzipFile(fileobj=BytesIO(source_content)) as compressed_file:
        decompressed_content = compressed_file.read(maximum_source_bytes + 1)
    ensure_source_size(len(decompressed_content))
    return decompressed_content


def remember_source(source_name: str, source_content: bytes, source_url: str | None) -> str:
    upload_token = uuid.uuid4().hex
    current_time = time.time()
    with source_cache_lock:
        for expired_token in [token for token, entry in source_cache.items() if entry["expires_at"] < current_time]:
            del source_cache[expired_token]
        source_cache[upload_token] = {"name": source_name, "content": source_content, "source_url": source_url, "expires_at": current_time + source_cache_ttl_seconds, "profiles": {}}
        cached_bytes = sum(len(entry["content"]) for entry in source_cache.values())
        for oldest_token in sorted(source_cache, key=lambda token: source_cache[token]["expires_at"]):
            if cached_bytes <= source_cache_max_bytes or oldest_token == upload_token:
                break
            cached_bytes -= len(source_cache[oldest_token]["content"])
            del source_cache[oldest_token]
    return upload_token


def cached_source(upload_token: str) -> dict[str, Any]:
    entry = source_cache.get(upload_token)
    if not entry or entry["expires_at"] < time.time():
        raise HTTPException(410, "A análise anterior expirou. Envie o arquivo ou o link novamente para continuar.")
    entry["expires_at"] = time.time() + source_cache_ttl_seconds
    return entry


def profile_cached_source(upload_token: str, source_kind: str, sheet_name: str | None) -> dict[str, Any]:
    entry = cached_source(upload_token)
    source_profile = profile_table(entry["name"], entry["content"], entry["source_url"], source_kind, sheet_name)
    entry["profiles"][source_profile.get("selected_sheet") or ""] = source_profile
    return {**source_profile, "upload_token": upload_token}


def persist_cached_source(upload_token: str, dataset_id: str | None, import_title: str | None, reference_year: int | None, sheet_name: str | None, include_all_sheets: bool) -> dict[str, Any]:
    entry = cached_source(upload_token)
    return persist_import(entry["name"], entry["content"], entry["source_url"], dataset_id, import_title or entry["name"], reference_year, sheet_name, include_all_sheets, entry["profiles"])


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


@app.get("/keepalive")
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
            supabase_url("/rest/v1/imports"),
            params={"select": "id", "limit": "1"},
            headers=supabase_headers(),
            timeout=10.0,
        )
    except httpx.TransportError:
        raise HTTPException(503, "Não foi possível consultar o banco de dados.")
    if not database_response.is_success:
        raise HTTPException(503, "Não foi possível consultar o banco de dados.")
    return {"status": "ok", "database": "reachable"}


def import_tables(source_name: str, source_content: bytes, selected_sheet: str | None, include_all_sheets: bool) -> list[tuple[str, pl.DataFrame]]:
    if not include_all_sheets or not selected_sheet:
        selected_sheet = resolve_sheet_name(source_name, source_content, selected_sheet)
    if include_all_sheets and Path(source_name).suffix.lower() == ".xlsx":
        tables: list[tuple[str, pl.DataFrame]] = []
        for sheet in workbook_sheets(source_content):
            try:
                source_table = normalize_table_columns(read_table(source_name, source_content, str(sheet["name"])))
            except HTTPException:
                continue
            if source_table.height and source_table.width:
                tables.append((str(sheet["name"]), source_table))
        if tables:
            return tables
        raise HTTPException(422, "Nenhuma aba da planilha contém uma tabela que possa ser importada.")
    source_table = normalize_table_columns(read_table(source_name, source_content, selected_sheet))
    return [(selected_sheet or "Dados", source_table)]


def discard_partial_import(source_id: str | None, import_id: str | None, storage_path: str | None) -> None:
    cleanup_requests = []
    if storage_path:
        cleanup_requests.append(lambda: httpx.delete(supabase_url(f"/storage/v1/object/source-files/{quote(storage_path, safe='/')}"), headers=supabase_headers(), timeout=30.0))
    if import_id:
        cleanup_requests.append(lambda: httpx.delete(supabase_url("/rest/v1/imports"), params={"id": f"eq.{import_id}"}, headers=supabase_headers(), timeout=30.0))
    if source_id:
        cleanup_requests.append(lambda: httpx.delete(supabase_url("/rest/v1/sources"), params={"id": f"eq.{source_id}"}, headers=supabase_headers(), timeout=30.0))
    for cleanup_request in cleanup_requests:
        try:
            cleanup_request()
        except Exception:
            continue


def persist_import(source_name: str, source_content: bytes, source_url: str | None, dataset_id: str | None, import_title: str, reference_year: int | None, sheet_name: str | None = None, include_all_sheets: bool = False, cached_profiles: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    selected_sheet = resolve_sheet_name(source_name, source_content, sheet_name)
    selected_tables = import_tables(source_name, source_content, selected_sheet, include_all_sheets)
    source_profile = (cached_profiles or {}).get(selected_sheet or "")
    if not source_profile:
        source_profile = profile_table(source_name, source_content, source_url, "uploaded_file" if source_url is None else "remote_file", selected_sheet)
    created: dict[str, str | None] = {"source_id": None, "import_id": None, "storage_path": None}
    try:
        return write_import_records(source_name, source_content, source_url, dataset_id, import_title, reference_year, selected_sheet, selected_tables, source_profile, created)
    except Exception as write_error:
        discard_partial_import(created["source_id"], created["import_id"], created["storage_path"])
        if isinstance(write_error, httpx.TransportError):
            raise HTTPException(502, "Perdemos a conexão com o Supabase enquanto a importação era gravada. Nada ficou gravado pela metade; tente novamente.") from write_error
        raise


def write_import_records(source_name: str, source_content: bytes, source_url: str | None, dataset_id: str | None, import_title: str, reference_year: int | None, selected_sheet: str | None, selected_tables: list[tuple[str, pl.DataFrame]], source_profile: dict[str, Any], created: dict[str, str | None]) -> dict[str, Any]:
    source_profile = {key: value for key, value in source_profile.items() if key != "upload_token"}
    source_record = {"name": source_name, "base_url": source_url}
    source_response = httpx.post(supabase_url("/rest/v1/sources"), headers=supabase_headers("return=representation"), json=source_record, timeout=30.0)
    if not source_response.is_success:
        raise HTTPException(502, "Não foi possível registrar a fonte no Supabase.")
    source_id = source_response.json()[0]["id"]
    created["source_id"] = source_id
    import_response = httpx.post(supabase_url("/rest/v1/imports"), headers=supabase_headers("return=representation"), json={"source_id": source_id, "dataset_id": dataset_id, "title": import_title, "reference_year": reference_year, "source_url": source_url, "file_name": source_name, "file_sha256": sha256(source_content).hexdigest(), "status": "needs_review", "profile": source_profile, "total_rows": sum(table.height for _, table in selected_tables)}, timeout=30.0)
    if not import_response.is_success:
        raise upstream_error("Não foi possível criar o rascunho da importação no Supabase.", import_response)
    import_record = import_response.json()[0]
    import_id = import_record["id"]
    created["import_id"] = import_id
    if selected_sheet:
        sheet_records = []
        table_by_sheet = dict(selected_tables)
        for sheet_position, sheet in enumerate(workbook_sheets(source_content), start=1):
            is_selected = sheet["name"] == selected_sheet
            imported_table = table_by_sheet.get(str(sheet["name"]))
            sheet_records.append({"import_id": import_id, "sheet_name": sheet["name"], "sheet_position": sheet_position, "row_count": imported_table.height if imported_table is not None else 0, "column_count": imported_table.width if imported_table is not None else 0, "columns_profile": source_profile["columns"] if is_selected else [], "sample_rows": source_profile["sample"] if is_selected else [], "selected_for_treatment": is_selected})
        sheets_response = httpx.post(supabase_url("/rest/v1/import_sheets"), headers=supabase_headers(), json=sheet_records, timeout=30.0)
        if not sheets_response.is_success:
            raise HTTPException(502, "Não foi possível registrar as abas da planilha. Confirme se a migration 0008_import_sheets.sql foi executada no Supabase.")
    original_storage_path = f"imports/{import_id}/original/{source_name}"
    storage_response = httpx.post(supabase_url(f"/storage/v1/object/source-files/{quote(original_storage_path, safe='/')}"), headers={**supabase_headers("resolution=merge-duplicates"), "Content-Type": "application/octet-stream", "x-upsert": "true"}, content=source_content, timeout=180.0)
    if not storage_response.is_success:
        raise HTTPException(502, "Não foi possível guardar o arquivo original no Storage. Nada ficou gravado pela metade; tente novamente.")
    created["storage_path"] = original_storage_path
    staged_rows = [{"import_id": import_id, "sheet_name": table_name, "row_number": row_number, "raw_row": row_values} for table_name, table in selected_tables for row_number, row_values in enumerate(table.to_dicts(), start=1)]
    for start_index in range(0, len(staged_rows), 500):
        staged_response = httpx.post(supabase_url("/rest/v1/import_rows"), headers=supabase_headers(), json=staged_rows[start_index:start_index + 500], timeout=30.0)
        if not staged_response.is_success:
            raise upstream_error("Não foi possível preparar as linhas para revisão. Nada ficou gravado pela metade; tente novamente.", staged_response)
    update_response = httpx.patch(supabase_url(f"/rest/v1/imports?id=eq.{import_id}"), headers=supabase_headers(), json={"storage_path": original_storage_path}, timeout=30.0)
    if not update_response.is_success:
        raise HTTPException(502, "O arquivo foi guardado, mas o caminho não pôde ser associado à importação.")
    return {"import_id": import_id, "status": "needs_review", "total_rows": sum(table.height for _, table in selected_tables), "imported_sheets": [table_name for table_name, _ in selected_tables], "profile": source_profile}


def normalize_column(column_name: str) -> str:
    normalized_name = "".join(character for character in unicodedata.normalize("NFKD", column_name.strip().lower()) if not unicodedata.combining(character))
    normalized_name = re.sub(r"_duplicated_(\d+)$", lambda match: f"_{int(match.group(1)) + 2}", normalized_name)
    return "_".join(normalized_name.replace("/", " ").split())


def normalize_table_columns(source_table: pl.DataFrame) -> pl.DataFrame:
    normalized_names: list[str] = []
    used_names: set[str] = set()
    for position, column_name in enumerate(source_table.columns, start=1):
        normalized_name = normalize_column(column_name)
        if not normalized_name or normalized_name.startswith("__unnamed__"):
            normalized_name = f"coluna_{position}"
        unique_name = normalized_name
        suffix = 2
        while unique_name in used_names:
            unique_name = f"{normalized_name}_{suffix}"
            suffix += 1
        normalized_names.append(unique_name)
        used_names.add(unique_name)
    normalized_table = source_table.rename(dict(zip(source_table.columns, normalized_names)))
    for column_name in [column_name for column_name in normalized_table.columns if is_municipality_code_column(column_name)]:
        code_as_text = pl.col(column_name).cast(pl.String)
        normalized_table = normalized_table.with_columns(
            pl.when(code_as_text.str.contains(r"^[0-9]{6,7}\.0+$"))
            .then(code_as_text.str.replace(r"\.0+$", ""))
            .otherwise(code_as_text)
            .alias(column_name)
        )
    return normalized_table


def is_municipality_code_column(column_name: str) -> bool:
    return re.search(r"ibge|cod(?:igo)?_(?:do_|de_)?mun|municipio_cod", column_name) is not None


def period_from_column_name(column_name: str) -> tuple[int, int] | None:
    month_numbers = {"janeiro": 1, "fevereiro": 2, "marco": 3, "abril": 4, "maio": 5, "junho": 6, "julho": 7, "agosto": 8, "setembro": 9, "outubro": 10, "novembro": 11, "dezembro": 12}
    normalized_name = normalized_sheet_title(normalize_column(column_name))
    period_match = re.search(r"(" + "|".join(month_numbers) + r")_(20[0-9]{2})", normalized_name)
    if not period_match:
        return None
    return int(period_match.group(2)), month_numbers[period_match.group(1)]


def is_public_address(host_name: str) -> bool:
    try:
        address_candidates = socket.getaddrinfo(host_name, None)
    except socket.gaierror:
        return False
    for address_candidate in address_candidates:
        if not ipaddress.ip_address(address_candidate[4][0]).is_global:
            return False
    return bool(address_candidates)


def validate_source_url(source_url: str) -> None:
    parsed_url = urlparse(source_url)
    if parsed_url.scheme != "https" or not parsed_url.hostname:
        raise HTTPException(400, "Use um link HTTPS público.")
    if not is_public_address(parsed_url.hostname):
        raise HTTPException(400, "O link não aponta para um endereço público permitido.")


def normalize_share_link(source_url: str) -> str:
    parsed_url = urlparse(source_url)
    if parsed_url.hostname in {"www.dropbox.com", "dropbox.com"}:
        query_params = parse_qs(parsed_url.query)
        query_params["dl"] = ["1"]
        return urlunparse(parsed_url._replace(query=urlencode(query_params, doseq=True)))
    return source_url


def is_bot_challenge(response_status: int, response_headers: httpx.Headers, response_content: bytes) -> bool:
    if "x-amzn-waf-action" in response_headers:
        return True
    if response_status == 403 and ("cf-mitigated" in response_headers or response_headers.get("server", "").lower() == "cloudflare"):
        return True
    if "text/html" in response_headers.get("content-type", ""):
        content_preview = response_content[:4096]
        return any(marker in content_preview for marker in (b"Just a moment", b"challenges.cloudflare.com", b"Human Verification", b"awsWafCookieDomainList"))
    return False


def resolve_source_file_name(final_url: str, content_type: str, content_disposition: str | None = None) -> str:
    disposition_header = Message()
    if content_disposition:
        disposition_header["Content-Disposition"] = content_disposition
    header_file_name = disposition_header.get_filename()
    source_name = Path(header_file_name).name if header_file_name else Path(urlparse(final_url).path).name
    source_name = source_name or "fonte-remota"
    if Path(source_name).suffix:
        return source_name
    media_type = content_type.split(";", 1)[0].strip().lower()
    extension_by_media_type = {
        "application/json": ".json",
        "text/csv": ".csv",
        "text/tab-separated-values": ".csv",
        "application/zip": ".zip",
        "application/gzip": ".gz",
        "application/x-gzip": ".gz",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "application/vnd.ms-excel": ".xls",
        "application/x-excel": ".xls",
    }
    return f"{source_name}{extension_by_media_type.get(media_type, '')}"


async def download_source(source_url: str) -> tuple[str, bytes, str, str]:
    current_url = normalize_share_link(source_url)
    validate_source_url(current_url)
    content_type = ""
    content_disposition = None
    source_content = b""
    final_url = current_url
    try:
        async with httpx.AsyncClient(timeout=180.0) as web_client:
            for _ in range(maximum_redirect_hops):
                async with web_client.stream("GET", current_url, headers={"User-Agent": "Decsys/0.2"}, follow_redirects=False) as streamed_response:
                    if streamed_response.is_redirect:
                        next_url = urljoin(current_url, streamed_response.headers.get("location", ""))
                        validate_source_url(next_url)
                        current_url = next_url
                        continue
                    content_type = streamed_response.headers.get("content-type", "")
                    content_disposition = streamed_response.headers.get("content-disposition")
                    declared_length = streamed_response.headers.get("content-length", "")
                    if declared_length.isdigit():
                        ensure_source_size(int(declared_length))
                    accumulated_content = bytearray()
                    async for content_chunk in streamed_response.aiter_bytes():
                        accumulated_content.extend(content_chunk)
                        ensure_source_size(len(accumulated_content))
                    source_content = bytes(accumulated_content)
                    if is_bot_challenge(streamed_response.status_code, streamed_response.headers, source_content):
                        raise HTTPException(403, "Este site tem proteção contra acesso automatizado (Cloudflare, AWS WAF ou similar) e bloqueou a leitura direta do link. Procure o link direto do arquivo em vez da página de apresentação (para dados do IBGE, por exemplo, tente ftp.ibge.gov.br).")
                    if streamed_response.is_error:
                        raise HTTPException(streamed_response.status_code, "Não foi possível baixar o material indicado pelo link.")
                    final_url = current_url
                    break
            else:
                raise HTTPException(400, "O link excedeu o número de redirecionamentos permitido.")
    except httpx.TransportError:
        raise HTTPException(502, "Não foi possível conectar a esse endereço. Confirme se o link está correto e se o site está no ar.")
    source_name = resolve_source_file_name(final_url, content_type, content_disposition)
    return source_name, source_content, content_type, final_url


def google_drive_api_key() -> str:
    api_key = os.getenv("GOOGLE_DRIVE_API_KEY")
    if not api_key:
        raise HTTPException(400, "Links do Google Drive exigem a variável GOOGLE_DRIVE_API_KEY configurada no serviço de ingestão.")
    return api_key


def parse_drive_url(source_url: str) -> tuple[str, str] | None:
    parsed_url = urlparse(source_url)
    if parsed_url.hostname not in {"drive.google.com", "docs.google.com"}:
        return None
    folder_match = re.search(r"/folders/([\w-]+)", parsed_url.path)
    if folder_match:
        return "folder", folder_match.group(1)
    file_match = re.search(r"/file/d/([\w-]+)", parsed_url.path)
    if file_match:
        return "file", file_match.group(1)
    query_id = parse_qs(parsed_url.query).get("id")
    if query_id:
        return "file", query_id[0]
    return None


def list_drive_folder(folder_id: str) -> list[dict[str, str]]:
    api_key = google_drive_api_key()
    list_response = httpx.get("https://www.googleapis.com/drive/v3/files", params={"q": f"'{folder_id}' in parents and trashed = false", "fields": "files(id,name)", "pageSize": 100, "key": api_key}, timeout=20.0)
    if not list_response.is_success:
        raise HTTPException(502, "Não foi possível listar os arquivos dessa pasta do Google Drive. Confirme se ela está compartilhada como \"qualquer pessoa com o link\".")
    candidates: list[dict[str, str]] = []
    for entry in list_response.json().get("files", []):
        file_name = entry.get("name", "arquivo")
        if Path(file_name).suffix.lower() in acceptable_extensions:
            candidates.append({"name": file_name, "url": f"https://drive.google.com/file/d/{entry['id']}/view"})
    return candidates


def fetch_drive_file(file_id: str) -> tuple[str, bytes, str]:
    api_key = google_drive_api_key()
    metadata_response = httpx.get(f"https://www.googleapis.com/drive/v3/files/{file_id}", params={"fields": "name", "key": api_key}, timeout=20.0)
    if not metadata_response.is_success:
        raise HTTPException(404, "Arquivo do Google Drive não encontrado, ou não compartilhado como \"qualquer pessoa com o link\".")
    file_name = metadata_response.json().get("name", "arquivo-drive")
    content_response = httpx.get(f"https://www.googleapis.com/drive/v3/files/{file_id}", params={"alt": "media", "key": api_key}, timeout=180.0)
    if not content_response.is_success:
        raise HTTPException(502, "Não foi possível baixar o arquivo do Google Drive.")
    return file_name, content_response.content, content_response.headers.get("content-type", "")


def decode_csv_text(source_content: bytes) -> str:
    for candidate_encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return source_content.decode(candidate_encoding)
        except UnicodeDecodeError:
            continue
    return source_content.decode("utf-8", errors="replace")


def detect_csv_separator(csv_text: str) -> str:
    sample_text = csv_text[:8192]
    try:
        return csv.Sniffer().sniff(sample_text, delimiters=";,\t|").delimiter
    except csv.Error:
        candidate_counts = {candidate: sample_text.count(candidate) for candidate in (";", ",", "\t", "|")}
        return max(candidate_counts, key=candidate_counts.get) if any(candidate_counts.values()) else ","


def normalize_brazilian_decimals(source_table: pl.DataFrame) -> pl.DataFrame:
    numeric_pattern = r"^-?(?:(?:[0-9]{1,3}(\.[0-9]{3})*|[0-9]+)(,[0-9]+)?|[0-9]+\.[0-9]+|,[0-9]+)$"
    normalized_columns: list[pl.Expr] = []
    for column_name, data_type in zip(source_table.columns, source_table.dtypes):
        if data_type != pl.String:
            continue
        non_empty_values = [str(value).strip() for value in source_table[column_name].drop_nulls().to_list() if str(value).strip() not in {"", "-"}]
        numeric_values = [value for value in non_empty_values if re.fullmatch(numeric_pattern, value)]
        has_decimal_separator = any("," in value or "." in value for value in numeric_values)
        if non_empty_values and has_decimal_separator and len(numeric_values) / len(non_empty_values) >= 0.6:
            trimmed_values = pl.col(column_name).cast(pl.String).str.strip_chars()
            brazilian_decimal_values = trimmed_values.str.replace_all(".", "", literal=True).str.replace(",", ".", literal=True)
            normalized_columns.append(
                pl.when(trimmed_values.is_in(["", "-"]))
                .then(None)
                .when(trimmed_values.str.contains(","))
                .then(brazilian_decimal_values)
                .otherwise(trimmed_values)
                .cast(pl.Float64, strict=False)
                .alias(column_name)
            )
    return source_table.with_columns(normalized_columns) if normalized_columns else source_table


def read_json_table(source_content: bytes) -> pl.DataFrame:
    source_records = json.loads(source_content)
    if isinstance(source_records, list) and source_records and isinstance(source_records[0], dict):
        label_record = source_records[0]
        has_sidra_labels = "V" in label_record and any(str(value).endswith("(Código)") for value in label_record.values())
        if has_sidra_labels:
            source_table = pl.from_dicts(source_records[1:])
            readable_names = unique_header_names([str(label_record.get(column_name, column_name)) for column_name in source_table.columns])
            return source_table.rename(dict(zip(source_table.columns, readable_names)))
    return pl.read_json(BytesIO(source_content))


def normalized_sheet_title(sheet_title: str) -> str:
    return "".join(character for character in unicodedata.normalize("NFKD", sheet_title).lower() if not unicodedata.combining(character)).strip()


def is_navigation_sheet(sheet_title: str) -> bool:
    return normalized_sheet_title(sheet_title) in {"sumario", "indice", "contents"}


def workbook_sheets(source_content: bytes) -> list[dict[str, int | str]]:
    workbook = load_workbook(BytesIO(source_content), read_only=True, data_only=True)
    return [{"name": worksheet.title, "rows": worksheet.max_row, "columns": worksheet.max_column} for worksheet in workbook.worksheets if not is_navigation_sheet(worksheet.title) and any(any(has_cell_value(cell_value) for cell_value in row_values) for row_values in worksheet.iter_rows(values_only=True))]


def has_cell_value(cell_value: Any) -> bool:
    return cell_value is not None and str(cell_value).strip() != ""


def has_excel_cell_value(cell_value: Any) -> bool:
    return has_cell_value(cell_value) and not str(cell_value).strip().lower().startswith("__unnamed__")


def is_numeric_cell(cell_value: Any) -> bool:
    if isinstance(cell_value, (int, float)) and not isinstance(cell_value, bool):
        return True
    if not isinstance(cell_value, str):
        return False
    numeric_text = cell_value.strip().replace(" ", "")
    if "," in numeric_text and "." in numeric_text:
        if numeric_text.rfind(",") > numeric_text.rfind("."):
            numeric_text = numeric_text.replace(".", "").replace(",", ".")
        else:
            numeric_text = numeric_text.replace(",", "")
    else:
        numeric_text = numeric_text.replace(",", ".")
    return re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", numeric_text) is not None


def unique_header_names(header_names: list[str]) -> list[str]:
    resolved_names: list[str] = []
    used_names: set[str] = set()
    for position, header_name in enumerate(header_names, start=1):
        base_name = header_name or f"Coluna {position}"
        unique_name = base_name
        suffix = 2
        while unique_name in used_names:
            unique_name = f"{base_name} ({suffix})"
            suffix += 1
        resolved_names.append(unique_name)
        used_names.add(unique_name)
    return resolved_names


def infer_excel_headers(source_content: bytes, sheet_name: str) -> dict[str, Any] | None:
    workbook = load_workbook(BytesIO(source_content), read_only=True, data_only=True)
    worksheet = workbook[sheet_name]
    sample_rows = list(worksheet.iter_rows(min_row=1, max_row=min(worksheet.max_row, 40), values_only=True))
    data_row_number = None
    for row_number, row_values in enumerate(sample_rows, start=1):
        populated_values = [cell_value for cell_value in row_values if has_excel_cell_value(cell_value)]
        numeric_count = sum(is_numeric_cell(cell_value) for cell_value in populated_values)
        if len(populated_values) >= 3 and numeric_count >= 2 and numeric_count / len(populated_values) >= 0.2:
            data_row_number = row_number
            break
    if data_row_number is None:
        populated_counts = [sum(has_excel_cell_value(cell_value) for cell_value in row_values) for row_values in sample_rows]
        maximum_populated_count = max(populated_counts, default=0)
        if maximum_populated_count < 2:
            return None
        header_row_index = populated_counts.index(maximum_populated_count)
        header_row = sample_rows[header_row_index]
        header_names = [" ".join(str(cell_value).split()) if has_cell_value(cell_value) else "" for cell_value in header_row]
        data_samples = sample_rows[header_row_index + 1:min(len(sample_rows), header_row_index + 6)]
        has_following_data = any(sum(has_excel_cell_value(cell_value) for cell_value in row_values) >= 2 for row_values in data_samples)
        if not has_following_data:
            return None
        data_columns = [column_index for column_index in range(worksheet.max_column) if any(column_index < len(row_values) and has_excel_cell_value(row_values[column_index]) for row_values in data_samples)]
        resolved_headers = [header_names[column_index] if column_index < len(header_names) else "" for column_index in data_columns]
        return {"header_row": header_row_index, "header_rows": [header_row_index + 1], "header_names": unique_header_names(resolved_headers)}
    if data_row_number == 1:
        return None
    header_start = data_row_number - 1
    while header_start > 1 and data_row_number - header_start < 3:
        previous_header_row = sample_rows[header_start - 2]
        populated_header_cells = sum(has_excel_cell_value(cell_value) for cell_value in previous_header_row)
        if populated_header_cells < 2:
            break
        header_start -= 1
    header_rows = sample_rows[header_start - 1:data_row_number - 1]
    data_samples = sample_rows[data_row_number - 1:min(len(sample_rows), data_row_number + 5)]
    carried_labels = ["" for _ in header_rows]
    header_names: list[str] = []
    for column_index in range(worksheet.max_column):
        labels: list[str] = []
        has_direct_header = False
        for level, header_row in enumerate(header_rows):
            cell_value = header_row[column_index] if column_index < len(header_row) else None
            if has_excel_cell_value(cell_value):
                has_direct_header = True
                header_text = str(cell_value).replace("-_x000d_\n", "").replace("-\n", "").replace("_x000d_", " ").replace("\r", " ").replace("\n", " ")
                carried_labels[level] = " ".join(header_text.split())
            if carried_labels[level] and carried_labels[level] not in labels:
                labels.append(carried_labels[level])
        has_data = any(column_index < len(data_row) and has_excel_cell_value(data_row[column_index]) for data_row in data_samples)
        if has_data:
            header_names.append(" ".join(labels) if has_direct_header else "")
    return {"header_row": data_row_number - 2, "header_rows": list(range(header_start, data_row_number)), "header_names": unique_header_names(header_names)}


def trim_trailing_spreadsheet_notes(source_table: pl.DataFrame) -> pl.DataFrame:
    if not source_table.height or not source_table.width:
        return source_table
    populated_fields = source_table.select(pl.sum_horizontal(*[pl.col(column_name).is_not_null().cast(pl.UInt16) for column_name in source_table.columns]).alias("populated_fields")).get_column("populated_fields").to_list()
    minimum_populated_fields = min(2, source_table.width)
    last_data_position = next((position for position in range(len(populated_fields) - 1, -1, -1) if populated_fields[position] >= minimum_populated_fields), -1)
    return source_table.slice(0, last_data_position + 1)


def read_excel_table(source_content: bytes, sheet_name: str) -> pl.DataFrame:
    header_configuration = infer_excel_headers(source_content, sheet_name)
    read_options = {"header_row": header_configuration["header_row"]} if header_configuration else {}
    try:
        source_table = pl.read_excel(BytesIO(source_content), sheet_name=sheet_name, infer_schema_length=500, read_options=read_options)
    except pl.exceptions.NoDataError:
        raise HTTPException(422, f'A aba "{sheet_name}" não possui dados para importar. Escolha outra aba da planilha.')
    if header_configuration and len(header_configuration["header_names"]) == source_table.width:
        source_table = source_table.rename(dict(zip(source_table.columns, header_configuration["header_names"])))
        repeated_header_row = pl.all_horizontal([
            pl.col(column_name).cast(pl.String).str.strip_chars().str.to_lowercase() == header_name.strip().lower()
            for column_name, header_name in zip(source_table.columns, header_configuration["header_names"])
        ])
        source_table = source_table.filter(~repeated_header_row)
    return trim_trailing_spreadsheet_notes(source_table)


def resolve_sheet_name(source_name: str, source_content: bytes, requested_sheet_name: str | None) -> str | None:
    source_extension = Path(source_name).suffix.lower()
    if source_extension not in {".xlsx", ".xls"}:
        return None
    if source_extension == ".xls":
        return requested_sheet_name
    available_sheets = workbook_sheets(source_content)
    if requested_sheet_name:
        if requested_sheet_name not in {str(sheet["name"]) for sheet in available_sheets}:
            raise HTTPException(422, "A aba selecionada não existe mais nessa planilha.")
        return requested_sheet_name
    sheet_candidates: list[tuple[int, str]] = []
    for sheet_candidate in available_sheets:
        try:
            candidate_table = read_table(source_name, source_content, str(sheet_candidate["name"]))
        except HTTPException:
            continue
        if candidate_table.height and candidate_table.width:
            sheet_candidates.append((candidate_table.height * candidate_table.width, str(sheet_candidate["name"])))
    if sheet_candidates:
        return max(sheet_candidates, key=lambda candidate: candidate[0])[1]
    raise HTTPException(422, "Nenhuma aba da planilha contém uma tabela que possa ser lida.")


def read_table(source_name: str, source_content: bytes, sheet_name: str | None = None) -> pl.DataFrame:
    if not source_content:
        raise HTTPException(422, "O arquivo está vazio. Envie uma planilha ou arquivo de dados válido.")
    try:
        return read_table_content(source_name, source_content, sheet_name)
    except HTTPException:
        raise
    except Exception as parse_error:
        raise HTTPException(422, "Não foi possível ler este arquivo. Confirme se ele não está corrompido e se o formato corresponde à extensão.") from parse_error


def read_table_content(source_name: str, source_content: bytes, sheet_name: str | None = None) -> pl.DataFrame:
    source_extension = Path(source_name).suffix.lower()
    if source_extension == ".gz":
        return read_table(Path(source_name).stem, bounded_gzip_decompress(source_content))
    if source_extension == ".zip":
        with zipfile.ZipFile(BytesIO(source_content)) as source_archive:
            candidate_members = [member for member in source_archive.namelist() if not member.endswith("/") and Path(member).suffix.lower() in supported_extensions]
            if not candidate_members:
                raise HTTPException(415, "O arquivo .zip não contém nenhum CSV, XLSX, XLS ou JSON.")
            chosen_member = candidate_members[0]
            ensure_source_size(source_archive.getinfo(chosen_member).file_size)
            return read_table(Path(chosen_member).name, source_archive.read(chosen_member))
    if source_extension == ".csv":
        csv_text = decode_csv_text(source_content)
        return normalize_brazilian_decimals(pl.read_csv(StringIO(csv_text), try_parse_dates=True, infer_schema_length=500, separator=detect_csv_separator(csv_text)))
    if source_extension == ".xlsx":
        selected_sheet = resolve_sheet_name(source_name, source_content, sheet_name)
        return normalize_brazilian_decimals(read_excel_table(source_content, str(selected_sheet)))
    if source_extension == ".xls":
        return normalize_brazilian_decimals(pl.read_excel(BytesIO(source_content), sheet_name=sheet_name, infer_schema_length=500))
    if source_extension == ".json":
        return normalize_brazilian_decimals(read_json_table(source_content))
    raise HTTPException(415, "Formato não suportado. Envie ou indique CSV, XLSX, XLS, JSON, ou um .zip/.gz contendo um desses formatos.")


def profile_table(source_name: str, source_content: bytes, source_url: str | None, source_kind: str, sheet_name: str | None = None) -> dict[str, Any]:
    selected_sheet = resolve_sheet_name(source_name, source_content, sheet_name)
    source_table = read_table(source_name, source_content, selected_sheet)
    source_table = normalize_table_columns(source_table)
    if not source_table.height or not source_table.width:
        raise HTTPException(422, "Não encontramos linhas e colunas de dados nesta aba. Escolha uma aba que contenha uma tabela.")
    null_counts = {column_name: int(source_table[column_name].null_count()) for column_name in source_table.columns}
    source_profile = {
        "kind": source_kind,
        "file_name": source_name,
        "source_url": source_url,
        "rows": source_table.height,
        "columns": [{"name": column_name, "dtype": str(source_table[column_name].dtype), "null_count": null_counts[column_name]} for column_name in source_table.columns],
        "sample": source_table.head(20).to_dicts(),
        "suggestions": suggest_mapping(source_table),
        "indicator_recommendations": recommend_indicators(source_table),
    }
    if Path(source_name).suffix.lower() == ".xlsx":
        sheet_profiles = []
        for sheet in workbook_sheets(source_content):
            if sheet["name"] == selected_sheet:
                sheet_profiles.append({**sheet, "rows": source_table.height, "columns": source_table.width})
                continue
            sheet_profiles.append({**sheet, "rows": max(int(sheet["rows"]) - 1, 0), "rows_estimated": True})
        source_profile["sheets"] = sheet_profiles
        source_profile["selected_sheet"] = selected_sheet
        header_configuration = infer_excel_headers(source_content, str(selected_sheet))
        if header_configuration:
            source_profile["reading_notes"] = [f"O Decsys identificou {len(header_configuration['header_rows'])} linha(s) de cabeçalho e combinou os títulos antes de ler os dados."]
        source_profile["quality_warnings"] = excel_quality_warnings(source_content, str(selected_sheet), source_table)
    if len(source_content) > ai_assessment_size_limit:
        source_profile["agent_assessment"] = {"status": "skipped", "summary": f"A leitura estrutural foi concluída. O arquivo tem mais de {ai_assessment_size_limit // (1024 * 1024)} MB, então a avaliação por IA foi pulada para manter a resposta rápida."}
    else:
        source_profile["agent_assessment"] = assess_source(source_profile)
    return source_profile


def excel_quality_warnings(source_content: bytes, sheet_name: str, source_table: pl.DataFrame) -> list[str]:
    quality_warnings: list[str] = []
    sparse_unlabeled_columns = []
    for column_name in source_table.columns:
        if not column_name.startswith("coluna_") or not source_table.height:
            continue
        populated_count = source_table.height - source_table[column_name].null_count()
        if populated_count and populated_count / source_table.height <= 0.1:
            sparse_unlabeled_columns.append(column_name)
    if sparse_unlabeled_columns:
        quality_warnings.append(f"Encontramos {len(sparse_unlabeled_columns)} coluna(s) sem título, com poucos valores. Confira se esses campos pertencem à tabela antes de mapear.")

    workbook = load_workbook(BytesIO(source_content), read_only=True, data_only=True)
    worksheet = workbook[sheet_name]
    title_text = " ".join(str(cell_value) for row_values in worksheet.iter_rows(min_row=1, max_row=min(worksheet.max_row, 5), values_only=True) for cell_value in row_values if has_excel_cell_value(cell_value))
    workbook.close()
    normalized_title_text = re.sub(r"[_\W]+", " ", title_text, flags=re.UNICODE)
    expected_count_match = re.search(r"\b(\d{1,4})\s+maiores?\b", normalized_title_text, re.IGNORECASE)
    if expected_count_match:
        expected_record_count = int(expected_count_match.group(1))
        if expected_record_count != source_table.height:
            quality_warnings.append(f"O título menciona {expected_record_count} registros, mas a tabela contém {source_table.height}. Confira se a planilha está completa antes de continuar.")
    return quality_warnings


def suggest_mapping(source_table: pl.DataFrame) -> dict[str, str]:
    suggestions: dict[str, str] = {}
    for column_name in source_table.columns:
        if is_municipality_code_column(column_name):
            suggestions.setdefault("municipality_code", column_name)
        elif "municipio" in column_name:
            suggestions["municipality_name"] = column_name
        if column_name in {"ano", "year", "periodo", "ano_referencia"}:
            suggestions["reference_year"] = column_name
        if column_name in {"valor", "value", "indice", "percentual"}:
            suggestions["value"] = column_name
    return suggestions


def latest_measure_field(source_columns: list[str], measure_token: str) -> str | None:
    monthly_pattern = re.compile(r"(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)_20[0-9]{2}.*" + re.escape(measure_token) + r"$")
    normalized_columns = [(column_name, normalized_sheet_title(normalize_column(column_name))) for column_name in source_columns]
    return next((column_name for column_name, normalized_column_name in reversed(normalized_columns) if monthly_pattern.search(normalized_column_name)), next((column_name for column_name, normalized_column_name in reversed(normalized_columns) if measure_token in normalized_column_name), None))


def recommend_indicators(source_table: pl.DataFrame) -> list[dict[str, str]]:
    source_columns = source_table.columns
    normalized_source_columns = [normalized_sheet_title(normalize_column(column_name)) for column_name in source_columns]
    source_columns_text = " ".join(normalized_source_columns)
    recommendations: list[dict[str, str]] = []
    if "codigo" in source_columns_text and "municipio" in source_columns_text and any(token in source_columns_text for token in ("admissoes", "desligamentos", "saldos", "estoque")):
        for measure_token, code, name, definition in (
            ("saldos", "caged_saldo_empregos", "Saldo de empregos formais", "Diferença entre admissões e desligamentos formais no período."),
            ("admissoes", "caged_admissoes", "Admissões formais", "Quantidade de admissões formais registradas no período."),
            ("desligamentos", "caged_desligamentos", "Desligamentos formais", "Quantidade de desligamentos formais registrados no período."),
            ("estoque", "caged_estoque_empregos", "Estoque de empregos formais", "Quantidade de vínculos formais de emprego no período."),
        ):
            value_field = latest_measure_field(source_columns, measure_token)
            if value_field:
                recommendations.append({"code": code, "name": name, "dimension": "trabalho", "definition": definition, "unit": "pessoas", "expected_frequency": "mensal", "value_field": value_field})
        return recommendations
    for column_name in source_columns:
        normalized_name = normalize_column(column_name)
        if "potencia" in normalized_name and normalized_name.endswith("kw"):
            recommendations.append({"code": "potencia_geracao_instalada", "name": "Potência de geração instalada", "dimension": "energia", "definition": "Potência declarada de empreendimentos de geração de energia.", "unit": "kW", "expected_frequency": "anual", "value_field": column_name})
            break
    return recommendations


def assessment_schema() -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "properties": {"summary": {"type": "string"}, "municipality_field": {"type": ["string", "null"]}, "year_field": {"type": ["string", "null"]}, "measure_field": {"type": ["string", "null"]}, "risks": {"type": "array", "items": {"type": "string"}}}, "required": ["summary", "municipality_field", "year_field", "measure_field", "risks"]}


def assessment_prompt(source_profile: dict[str, Any]) -> str:
    return "Avalie esta fonte de dados urbanos. Não invente significados de campos. Identifique somente o que estiver sustentado pelas colunas e pela amostra. A resposta será revisada por uma pessoa antes de qualquer importação. Responda somente no objeto JSON solicitado, sem encapsular em outro campo. Fonte: " + json.dumps(source_profile, ensure_ascii=False, default=str)


def assess_with_openai(source_profile: dict[str, Any]) -> dict[str, Any]:
    response = OpenAI(api_key=os.environ["OPENAI_API_KEY"]).responses.create(model=os.getenv("OPENAI_MODEL", "gpt-5-mini"), input=assessment_prompt(source_profile), text={"format": {"type": "json_schema", "name": "source_assessment", "strict": True, "schema": assessment_schema()}})
    return {"status": "available", "provider": "openai", **json.loads(response.output_text)}


def assess_with_gemini(source_profile: dict[str, Any]) -> dict[str, Any]:
    gemini_model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    gemini_response = httpx.post(f"https://generativelanguage.googleapis.com/v1beta/models/{gemini_model}:generateContent", params={"key": os.environ["GEMINI_API_KEY"]}, json={"contents": [{"role": "user", "parts": [{"text": assessment_prompt(source_profile)}]}], "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": assessment_schema(), "temperature": 0.1}}, timeout=ai_assessment_timeout)
    gemini_response.raise_for_status()
    response_text = gemini_response.json()["candidates"][0]["content"]["parts"][0]["text"]
    return {"status": "available", "provider": "gemini", **json.loads(response_text)}


def assess_source(source_profile: dict[str, Any]) -> dict[str, Any]:
    global ai_unavailable_until
    provider = os.getenv("AI_PROVIDER", "gemini").lower()
    has_provider_key = (provider == "gemini" and os.getenv("GEMINI_API_KEY")) or (provider == "openai" and os.getenv("OPENAI_API_KEY"))
    if not has_provider_key:
        return {"status": "not_configured", "summary": f"A leitura estrutural foi concluída. Configure a chave do provedor {provider} para receber a avaliação do agente."}
    if time.monotonic() < ai_unavailable_until:
        return {"status": "unavailable", "summary": "A estrutura foi lida. A avaliação por IA está temporariamente indisponível, então o Decsys seguirá com sugestões automáticas."}
    try:
        if provider == "openai":
            return assess_with_openai(source_profile)
        if provider == "gemini":
            return assess_with_gemini(source_profile)
        return {"status": "not_configured", "summary": "O provedor de IA configurado não é suportado."}
    except Exception:
        ai_unavailable_until = time.monotonic() + 300
        return {"status": "unavailable", "summary": "A estrutura foi lida, mas a avaliação do agente não ficou disponível para esta fonte."}


def discover_downloads(page_content: bytes, page_url: str) -> list[dict[str, str]]:
    document = BeautifulSoup(page_content, "html.parser")
    downloads: list[dict[str, str]] = []
    for link_element in document.select("a[href]"):
        candidate_url = urljoin(page_url, str(link_element.get("href")))
        candidate_name = Path(urlparse(candidate_url).path).name
        if urlparse(candidate_url).scheme in {"http", "https"} and Path(candidate_name).suffix.lower() in acceptable_extensions:
            downloads.append({"name": candidate_name, "url": candidate_url})
    return list({download["url"]: download for download in downloads}.values())[:20]


def discover_ckan_resources(page_url: str) -> list[dict[str, str]]:
    parsed_url = urlparse(page_url)
    path_segments = [segment for segment in parsed_url.path.split("/") if segment]
    query_parameters = parse_qs(parsed_url.query)
    api_url = f"{parsed_url.scheme}://{parsed_url.netloc}/api/3/action/package_show"
    try:
        if "dataset" in path_segments and path_segments.index("dataset") < len(path_segments) - 1:
            ckan_response = httpx.get(api_url, params={"id": path_segments[path_segments.index("dataset") + 1]}, timeout=15.0)
            package_records = [ckan_response.json().get("result", {})]
        elif "groups" in query_parameters or "tags" in query_parameters:
            group_name = (query_parameters.get("groups") or [None])[0]
            tag_name = (query_parameters.get("tags") or [None])[0]
            search_response = httpx.get(f"{parsed_url.scheme}://{parsed_url.netloc}/api/3/action/package_search", params={"fq": f"groups:{group_name}" if group_name else f"tags:{tag_name}", "rows": 100}, timeout=15.0)
            search_response.raise_for_status()
            package_records = search_response.json().get("result", {}).get("results", [])
        else:
            return []
    except (httpx.HTTPError, ValueError):
        return []
    candidates: list[dict[str, str]] = []
    for package_record in package_records:
      for resource in package_record.get("resources", []):
        resource_url = resource.get("url")
        if not resource_url:
            continue
        resource_format = str(resource.get("format") or "").strip(".").lower()
        resource_name = resource.get("name") or Path(urlparse(resource_url).path).name or "recurso"
        looks_supported = Path(urlparse(resource_url).path).suffix.lower() in acceptable_extensions or resource_format in {"csv", "xlsx", "xls", "json", "zip"}
        if looks_supported:
            candidates.append({"name": resource_name, "url": resource_url})
    return candidates[:20]


def discover_munic_resources(page_url: str) -> list[dict[str, str]]:
    if "ibge.gov.br" not in urlparse(page_url).netloc or "munic" not in page_url.lower() and "10586" not in page_url:
        return []
    try:
        ftp_response = httpx.get("https://ftp.ibge.gov.br/Perfil_Municipios/2024/Base_de_Dados/", timeout=20.0)
        ftp_response.raise_for_status()
    except httpx.HTTPError:
        return []
    return discover_downloads(ftp_response.content, str(ftp_response.url))


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


indicator_fields = "id,code,name,dimension,definition,unit,expected_frequency,active"


indicator_registry_path = "/rest/v1/indicator_registry"
missing_registry_message = "Execute a migration 0014_public_indicator_registry.sql no Supabase para cadastrar e editar indicadores."


def registry_error(message: str, response: Any) -> HTTPException:
    if response.status_code == 404:
        return HTTPException(503, missing_registry_message)
    return upstream_error(message, response)


@app.get("/indicators")
def list_indicators() -> list[dict[str, Any]]:
    indicators_response = httpx.get(supabase_url(indicator_registry_path), params={"select": indicator_fields, "active": "is.true", "order": "name"}, headers=supabase_headers(), timeout=30.0)
    if indicators_response.is_success:
        return indicators_response.json()
    fallback_response = httpx.post(supabase_url("/rest/v1/rpc/list_active_indicators"), headers=supabase_headers(), json={}, timeout=30.0)
    if not fallback_response.is_success:
        raise upstream_error("Não foi possível carregar os indicadores.", fallback_response)
    return fallback_response.json()


@app.get("/indicators/{indicator_id}")
def get_indicator(indicator_id: str) -> dict[str, Any]:
    indicator_response = httpx.get(supabase_url(indicator_registry_path), params={"select": indicator_fields, "id": f"eq.{indicator_id}"}, headers=supabase_headers(), timeout=30.0)
    if not indicator_response.is_success:
        raise registry_error("Não foi possível carregar o indicador.", indicator_response)
    if not indicator_response.json():
        raise HTTPException(404, "Indicador não encontrado.")
    return indicator_response.json()[0]


@app.patch("/indicators/{indicator_id}")
def update_indicator(indicator_id: str, indicator: IndicatorUpdate) -> dict[str, Any]:
    indicator_values = {"name": indicator.name.strip(), "dimension": indicator.dimension.strip(), "definition": indicator.definition.strip(), "unit": indicator.unit.strip(), "expected_frequency": indicator.expected_frequency.strip() if indicator.expected_frequency else None}
    if not all(indicator_values[field_name] for field_name in ("name", "dimension", "definition", "unit")):
        raise HTTPException(422, "Preencha nome, dimensão, definição e unidade.")
    indicator_response = httpx.patch(supabase_url(indicator_registry_path), params={"id": f"eq.{indicator_id}"}, headers=supabase_headers("return=representation"), json=indicator_values, timeout=30.0)
    if not indicator_response.is_success:
        raise registry_error("Não foi possível atualizar o indicador.", indicator_response)
    if not indicator_response.json():
        raise HTTPException(404, "Indicador não encontrado.")
    return indicator_response.json()[0]


@app.post("/indicators/{indicator_id}/deactivate")
def deactivate_indicator(indicator_id: str) -> dict[str, Any]:
    indicator_response = httpx.patch(supabase_url(indicator_registry_path), params={"id": f"eq.{indicator_id}"}, headers=supabase_headers("return=representation"), json={"active": False}, timeout=30.0)
    if not indicator_response.is_success:
        raise registry_error("Não foi possível desativar o indicador.", indicator_response)
    if not indicator_response.json():
        raise HTTPException(404, "Indicador não encontrado.")
    return indicator_response.json()[0]


@app.get("/indicator-dimensions")
def list_indicator_dimensions() -> list[str]:
    dimension_names: list[str] = []
    dimension_response = httpx.get(supabase_url("/rest/v1/iiu_dimension_catalog"), params={"select": "name,display_order", "city_profile": "eq.medio", "order": "display_order"}, headers=supabase_headers(), timeout=30.0)
    if dimension_response.is_success:
        dimension_names.extend(str(record["name"]) for record in dimension_response.json())
    indicators_response = httpx.get(supabase_url(indicator_registry_path), params={"select": "dimension"}, headers=supabase_headers(), timeout=30.0)
    if indicators_response.is_success:
        dimension_names.extend(str(record["dimension"]) for record in indicators_response.json() if record.get("dimension"))
    return list(dict.fromkeys(name.strip() for name in dimension_names if name.strip()))


@app.get("/imports")
def list_imports(status: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    query_parameters = {"select": "id,title,file_name,source_url,status,total_rows,created_at,updated_at", "order": "created_at.desc", "limit": str(max(1, min(limit, 500))), "status": "neq.discarded"}
    if status in {"draft", "analyzing", "needs_review", "approved", "archived"}:
        query_parameters["status"] = f"eq.{status}"
    imports_response = httpx.get(supabase_url("/rest/v1/imports"), params=query_parameters, headers=supabase_headers(), timeout=30.0)
    if not imports_response.is_success:
        raise upstream_error("Não foi possível carregar as importações salvas.", imports_response)
    return imports_response.json()


def total_from_content_range(content_range: str | None, fallback_total: int) -> int:
    total_text = (content_range or "").rsplit("/", 1)[-1]
    return int(total_text) if total_text.isdigit() else fallback_total


@app.get("/dashboard-values")
def list_dashboard_values(indicator_code: str | None = None, dataset_id: str | None = None, limit: int = 200, offset: int = 0) -> dict[str, Any]:
    page_limit = max(1, min(limit, 1000))
    page_offset = max(0, offset)
    query_parameters: dict[str, str] = {"select": "id,dataset_id,dataset_name,domain_name,indicator_code,indicator_name,dimensions,reference_period,value,unit,import_title,source_name", "order": "reference_period.desc,id", "limit": str(page_limit), "offset": str(page_offset)}
    if indicator_code:
        query_parameters["indicator_code"] = f"eq.{indicator_code}"
    if dataset_id:
        query_parameters["dataset_id"] = f"eq.{dataset_id}"
    values_response = httpx.get(supabase_url("/rest/v1/dashboard_values"), params={**query_parameters, "select": f"{query_parameters['select']},period_granularity"}, headers=supabase_headers("count=exact"), timeout=30.0)
    if values_response.status_code == 400:
        values_response = httpx.get(supabase_url("/rest/v1/dashboard_values"), params=query_parameters, headers=supabase_headers("count=exact"), timeout=30.0)
    if not values_response.is_success:
        raise upstream_error("Não foi possível carregar os dados revisados.", values_response)
    dashboard_values = values_response.json()
    municipality_codes = sorted({code for value in dashboard_values if re.fullmatch(r"[0-9]{7}", code := str((value.get("dimensions") or {}).get("municipality_ibge_code") or ""))})
    municipality_names: dict[str, str] = {}
    if municipality_codes:
        municipalities_response = httpx.get(supabase_url("/rest/v1/iiu_municipalities"), params={"select": "ibge_code,name,state", "ibge_code": f"in.({','.join(municipality_codes)})"}, headers=supabase_headers(), timeout=30.0)
        if municipalities_response.is_success:
            municipality_names = {record["ibge_code"]: f"{record['name']} ({record['state']})" for record in municipalities_response.json()}
    for value in dashboard_values:
        value["municipality_name"] = municipality_names.get(str((value.get("dimensions") or {}).get("municipality_ibge_code") or ""))
    return {"items": dashboard_values, "total": total_from_content_range(values_response.headers.get("content-range"), page_offset + len(dashboard_values)), "limit": page_limit, "offset": page_offset}


@app.get("/iiu-municipalities")
def search_iiu_municipalities(search: str = "") -> list[dict[str, Any]]:
    query_parameters = {"select": "ibge_code,name,state", "order": "name", "limit": "20"}
    if search.strip():
        query_parameters["or"] = f"(ibge_code.ilike.*{search.strip()}*,name.ilike.*{search.strip()}*)"
    municipalities_response = httpx.get(supabase_url("/rest/v1/iiu_municipalities"), params=query_parameters, headers=supabase_headers(), timeout=30.0)
    if not municipalities_response.is_success:
        raise HTTPException(502, "Não foi possível carregar os municípios do IIU.")
    return municipalities_response.json()


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


@app.get("/iiu-dashboard/{municipality_code}")
def get_iiu_dashboard(municipality_code: str, city_profile: str = "medio") -> dict[str, Any]:
    is_demonstration = municipality_code == "demo"
    if not is_demonstration and not re.fullmatch(r"[0-9]{7}", municipality_code):
        raise HTTPException(422, "Informe um código IBGE de município com sete dígitos.")
    if city_profile not in {"pequeno", "medio", "grande", "metropole"}:
        raise HTTPException(422, "Escolha um porte de município válido para o cálculo do IIU.")
    catalog_response = httpx.get(supabase_url("/rest/v1/iiu_indicator_catalog"), params={"select": "*", "order": "display_order,name"}, headers=supabase_headers(), timeout=30.0)
    dimension_response = httpx.get(supabase_url("/rest/v1/iiu_dimension_catalog"), params={"city_profile": f"eq.{city_profile}", "select": "*", "order": "display_order"}, headers=supabase_headers(), timeout=30.0)
    benchmark_response = httpx.get(supabase_url("/rest/v1/iiu_indicator_benchmark_catalog"), params={"city_profile": f"eq.{city_profile}", "select": "*"}, headers=supabase_headers(), timeout=30.0)
    values_response = httpx.get(supabase_url("/rest/v1/dashboard_values"), params={"dimensions->>municipality_ibge_code": f"eq.{municipality_code}", "select": "indicator_code,value,reference_period,unit,source_name,import_title", "order": "reference_period.desc", "limit": "1000"}, headers=supabase_headers(), timeout=30.0)
    if not all(response.is_success for response in (catalog_response, dimension_response, benchmark_response, values_response)):
        raise HTTPException(502, "Não foi possível montar o IIU. Confirme se a migration 0012_iiu_framework.sql foi executada no Supabase.")
    latest_values: dict[str, dict[str, Any]] = {}
    for published_value in values_response.json():
        latest_values.setdefault(published_value["indicator_code"], published_value)
    if is_demonstration:
        latest_values = {code: {"indicator_code": code, "value": value, "reference_period": "2025-01-01", "unit": unit, "source_name": "Demonstração DECSYS", "import_title": "Valores sintéticos - não oficiais"} for code, (value, unit) in iiu_demonstration_values.items()}
    benchmark_by_indicator = {benchmark["indicator_code"]: benchmark for benchmark in benchmark_response.json()}
    indicators_by_dimension: dict[str, list[dict[str, Any]]] = {}
    for indicator in catalog_response.json():
        published_value = latest_values.get(indicator["code"])
        benchmark = benchmark_by_indicator.get(indicator["code"])
        raw_value = float(published_value["value"]) if published_value and published_value["value"] is not None else None
        score = iiu_score(raw_value, indicator["score_direction"], float(benchmark["minimum_value"]) if benchmark else None, float(benchmark["maximum_value"]) if benchmark else None, float(indicator["checklist_max"]) if indicator["checklist_max"] is not None else None) if raw_value is not None else None
        indicators_by_dimension.setdefault(indicator["iiu_dimension_code"], []).append({"code": indicator["code"], "name": indicator["name"], "type": indicator["iiu_type"], "unit": indicator["unit"], "formula": indicator["formula"], "source": indicator["source_description"], "direction": indicator["score_direction"], "raw_value": raw_value, "reference_period": published_value["reference_period"] if published_value else None, "score": score, "benchmark": {"minimum": float(benchmark["minimum_value"]), "maximum": float(benchmark["maximum_value"])} if benchmark else None})
    dimensions = []
    weighted_scores: list[tuple[float, float]] = []
    for dimension in dimension_response.json():
        dimension_indicators = indicators_by_dimension.get(dimension["code"], [])
        valid_scores = [indicator["score"] for indicator in dimension_indicators if indicator["score"] is not None]
        dimension_score = sum(valid_scores) / len(valid_scores) if valid_scores else None
        if dimension_score is not None:
            weighted_scores.append((dimension_score, float(dimension["weight"])))
        dimensions.append({"code": dimension["code"], "name": dimension["name"], "color": dimension["color"], "weight": float(dimension["weight"]), "score": dimension_score, "indicators": dimension_indicators, "scored_indicators": len(valid_scores), "observed_indicators": sum(1 for indicator in dimension_indicators if indicator["raw_value"] is not None), "total_indicators": len(dimension_indicators)})
    overall_score = sum(score * weight for score, weight in weighted_scores) / sum(weight for _, weight in weighted_scores) if weighted_scores else None
    maturity = next((level for level in ((20, "Nível 1 - Inicial"), (40, "Nível 2 - Em desenvolvimento"), (60, "Nível 3 - Estruturado"), (80, "Nível 4 - Gerenciado"), (100, "Nível 5 - Otimizado")) if overall_score is not None and overall_score <= level[0]), None)
    return {"municipality_ibge_code": municipality_code, "city_profile": city_profile, "is_demonstration": is_demonstration, "overall_score": overall_score, "maturity": maturity[1] if maturity else None, "observed_indicators": sum(dimension["observed_indicators"] for dimension in dimensions), "scored_indicators": sum(dimension["scored_indicators"] for dimension in dimensions), "total_indicators": sum(dimension["total_indicators"] for dimension in dimensions), "dimensions": dimensions}


@app.post("/indicators")
def create_indicator(indicator: IndicatorRegistration) -> dict[str, Any]:
    indicator_code = normalize_column(indicator.code)
    if not re.fullmatch(r"[a-z][a-z0-9_]{2,99}", indicator_code):
        raise HTTPException(422, "O código deve ter letras minúsculas, números ou sublinhados e começar com uma letra.")
    indicator_response = httpx.post(supabase_url(indicator_registry_path), headers=supabase_headers("return=representation"), json={"code": indicator_code, "name": indicator.name.strip(), "dimension": indicator.dimension.strip(), "definition": indicator.definition.strip(), "unit": indicator.unit.strip(), "expected_frequency": indicator.expected_frequency.strip() if indicator.expected_frequency else None}, timeout=30.0)
    if indicator_response.status_code == 409:
        raise HTTPException(409, "Já existe um indicador com esse código.")
    if not indicator_response.is_success:
        raise registry_error("Não foi possível cadastrar o indicador no Supabase.", indicator_response)
    return indicator_response.json()[0]


@app.post("/profile")
async def profile_file(file: UploadFile | None = File(None), sheet_name: str | None = Form(None), upload_token: str | None = Form(None)) -> dict[str, Any]:
    if upload_token:
        return await run_in_threadpool(profile_cached_source, upload_token, "uploaded_file", sheet_name)
    if file is None or not file.filename:
        raise HTTPException(400, "Envie um arquivo para analisar.")
    source_content = await read_upload(file)
    upload_token = remember_source(file.filename, source_content, None)
    return await run_in_threadpool(profile_cached_source, upload_token, "uploaded_file", sheet_name)


async def fetch_link_source(source_url: str) -> tuple[str, bytes, str, str, list[dict[str, str]] | None]:
    drive_target = parse_drive_url(source_url)
    if drive_target:
        drive_kind, drive_id = drive_target
        if drive_kind == "folder":
            drive_candidates = await run_in_threadpool(list_drive_folder, drive_id)
            if drive_candidates:
                return "", b"", "", source_url, drive_candidates
            raise HTTPException(415, "Não encontramos arquivos compatíveis nessa pasta do Google Drive, ou ela não está compartilhada publicamente.")
        source_name, source_content, _ = await run_in_threadpool(fetch_drive_file, drive_id)
        ensure_source_size(len(source_content))
        return source_name, source_content, "", source_url, None
    source_name, source_content, content_type, final_url = await download_source(source_url)
    return source_name, source_content, content_type, final_url, None


def is_page_response(source_name: str, content_type: str) -> bool:
    return "text/html" in content_type or Path(source_name).suffix.lower() not in acceptable_extensions


def discover_page_candidates(page_content: bytes, page_url: str) -> list[dict[str, str]]:
    return discover_ckan_resources(page_url) or discover_munic_resources(page_url) or discover_downloads(page_content, page_url)


@app.post("/profile-link")
async def profile_link(link_request: LinkRequest) -> dict[str, Any]:
    if link_request.upload_token:
        return await run_in_threadpool(profile_cached_source, link_request.upload_token, "remote_file", link_request.sheet_name)
    source_name, source_content, content_type, final_url, folder_candidates = await fetch_link_source(str(link_request.source_url))
    if folder_candidates is not None:
        return {"kind": "web_page", "source_url": final_url, "download_candidates": folder_candidates}
    if not parse_drive_url(str(link_request.source_url)) and is_page_response(source_name, content_type):
        page_candidates = await run_in_threadpool(discover_page_candidates, source_content, final_url)
        if page_candidates:
            return {"kind": "web_page", "source_url": final_url, "download_candidates": page_candidates}
        raise HTTPException(415, "A página não apresentou um arquivo CSV, XLSX, XLS, JSON ou ZIP identificável.")
    upload_token = remember_source(source_name, source_content, final_url)
    return await run_in_threadpool(profile_cached_source, upload_token, "remote_file", link_request.sheet_name)


@app.post("/imports/draft")
async def create_import_draft(file: UploadFile | None = File(None), dataset_id: str | None = Form(None), title: str | None = Form(None), reference_year: int | None = Form(None), sheet_name: str | None = Form(None), include_all_sheets: bool = Form(False), upload_token: str | None = Form(None)) -> dict[str, Any]:
    if upload_token:
        return await run_in_threadpool(persist_cached_source, upload_token, dataset_id, title, reference_year, sheet_name, include_all_sheets)
    if file is None or not file.filename:
        raise HTTPException(400, "Envie um arquivo para criar o rascunho.")
    source_content = await read_upload(file)
    return await run_in_threadpool(persist_import, file.filename, source_content, None, dataset_id, title or file.filename, reference_year, sheet_name, include_all_sheets)


@app.post("/imports/draft-link")
async def create_link_import_draft(link_request: LinkRequest) -> dict[str, Any]:
    if link_request.upload_token:
        return await run_in_threadpool(persist_cached_source, link_request.upload_token, link_request.dataset_id, link_request.title, link_request.reference_year, link_request.sheet_name, link_request.include_all_sheets)
    drive_target = parse_drive_url(str(link_request.source_url))
    if drive_target and drive_target[0] == "folder":
        raise HTTPException(415, "Escolha um arquivo específico da pasta do Google Drive antes de criar o rascunho.")
    source_name, source_content, content_type, final_url, _ = await fetch_link_source(str(link_request.source_url))
    if not drive_target and is_page_response(source_name, content_type):
        raise HTTPException(415, "Use o link direto de um arquivo para criar o rascunho.")
    return await run_in_threadpool(persist_import, source_name, source_content, final_url, link_request.dataset_id, link_request.title or source_name, link_request.reference_year, link_request.sheet_name, link_request.include_all_sheets)


@app.post("/imports/{import_id}/discard")
def discard_import(import_id: str) -> dict[str, str]:
    import_response = httpx.get(supabase_url("/rest/v1/imports"), params={"id": f"eq.{import_id}", "select": "storage_path"}, headers=supabase_headers(), timeout=30.0)
    if not import_response.is_success or not import_response.json():
        raise HTTPException(404, "Importação não encontrada.")
    storage_path = import_response.json()[0].get("storage_path")
    if storage_path:
        storage_response = httpx.delete(supabase_url(f"/storage/v1/object/source-files/{storage_path}"), headers=supabase_headers(), timeout=30.0)
        if not storage_response.is_success:
            raise HTTPException(502, "Não foi possível remover o arquivo privado da importação.")
    discard_response = httpx.patch(supabase_url(f"/rest/v1/imports?id=eq.{import_id}"), headers=supabase_headers(), json={"status": "discarded", "storage_path": None}, timeout=30.0)
    if not discard_response.is_success:
        raise HTTPException(502, "Não foi possível descartar a importação.")
    return {"import_id": import_id, "status": "discarded"}


@app.post("/imports/{import_id}/approve-municipal")
def approve_municipal_import(import_id: str, approval: MunicipalApproval) -> dict[str, Any]:
    period = approval.period or (PeriodSelection(mode="year_column", year_field=approval.year_field) if approval.year_field else None)
    if not period:
        raise HTTPException(422, "Informe como o período aparece na planilha.")
    validate_period_selection(period)
    ensure_municipal_catalog_registered()
    is_already_prepared = period.mode == "prepared" and approval.value_field == "value" and approval.municipality_field == "municipality_ibge_code"
    period_problems: list[dict[str, Any]] = []
    value_problems: list[dict[str, Any]] = []
    municipality_problems: list[dict[str, Any]] = []
    rpc_municipality_field = "municipality_ibge_code"
    if not is_already_prepared:
        staged_rows = fetch_rows_for_municipality_resolution(import_id, approval.sheet_name)
        resolve_municipality = municipality_code_resolver(ibge_municipality_catalog())
        prepared_rows, period_problems, value_problems, municipality_problems = prepare_rows_for_approval(staged_rows, period, approval.value_field, approval.municipality_field, resolve_municipality)
        upsert_staged_rows(import_id, approval.sheet_name, prepared_rows, "Não foi possível preparar município, período e valor das linhas antes da gravação.")
        rpc_municipality_field = approval_municipality_field
    approval_response = httpx.post(supabase_url("/rest/v1/rpc/approve_municipal_import"), headers=supabase_headers(), json={"selected_import_id": import_id, "selected_indicator_id": approval.indicator_id, "municipality_field": rpc_municipality_field, "year_field": "reference_year", "value_field": "value", "observation_unit": approval.unit, "selected_sheet_name": approval.sheet_name}, timeout=300.0)
    if not approval_response.is_success:
        raise upstream_error("Não foi possível aprovar a importação municipal.", approval_response)
    approved_rows = int(approval_response.json())
    return {
        "import_id": import_id,
        "status": "approved" if approved_rows else "needs_review",
        "approved_rows": approved_rows,
        "period_problem_count": len(period_problems),
        "period_problems": period_problems[:5],
        "value_problem_count": len(value_problems),
        "value_problems": value_problems[:5],
        "municipality_problem_count": len(municipality_problems),
        "municipality_problems": municipality_problems[:5],
    }


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
            registration_response = httpx.post(supabase_url("/rest/v1/rpc/register_municipalities"), headers=supabase_headers(), json={"selected_municipalities": municipality_catalog[start_index:start_index + 1000]}, timeout=60.0)
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


@app.post("/imports/{import_id}/municipality-matches")
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


@app.post("/imports/{import_id}/apply-municipality-matches")
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
            supabase_url("/rest/v1/rpc/register_municipalities"),
            headers=supabase_headers(),
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
    upsert_staged_rows(import_id, resolution.sheet_name, updated_rows, "Alguns códigos foram preparados, mas não conseguimos salvar todas as correspondências. Tente aplicar novamente.")
    return {"import_id": import_id, "applied_count": len(resolution.matches), "municipality_field": "municipality_ibge_code"}


def upsert_staged_rows(import_id: str, sheet_name: str | None, updated_rows: list[tuple[dict[str, Any], dict[str, Any]]], failure_message: str) -> None:
    records = [{
        "id": staged_row["id"],
        "import_id": import_id,
        "sheet_name": staged_row.get("sheet_name") or sheet_name or "Dados",
        "row_number": staged_row["row_number"],
        "raw_row": staged_row["raw_row"],
        "normalized_row": normalized_row,
    } for staged_row, normalized_row in updated_rows]
    for start_index in range(0, len(records), 500):
        try:
            rows_response = httpx.post(
                supabase_url("/rest/v1/import_rows"),
                params={"on_conflict": "id"},
                headers=supabase_headers("resolution=merge-duplicates,return=minimal"),
                json=records[start_index:start_index + 500],
                timeout=60.0,
            )
        except httpx.TransportError:
            raise HTTPException(502, "Perdemos a conexão com o Supabase ao preparar as linhas. Confira a importação e tente novamente.")
        if not rows_response.is_success:
            raise upstream_error(failure_message, rows_response)


month_numbers_by_name = {
    "janeiro": 1, "jan": 1, "fevereiro": 2, "fev": 2, "marco": 3, "mar": 3, "abril": 4, "abr": 4,
    "maio": 5, "mai": 5, "junho": 6, "jun": 6, "julho": 7, "jul": 7, "agosto": 8, "ago": 8,
    "setembro": 9, "set": 9, "outubro": 10, "out": 10, "novembro": 11, "nov": 11, "dezembro": 12, "dez": 12,
}


def cell_text(cell_value: Any) -> str:
    return "" if cell_value is None else str(cell_value).strip()


def valid_period(year: int, month: int | None) -> tuple[int, int | None] | None:
    if not 1900 <= year <= 2200 or (month is not None and not 1 <= month <= 12):
        return None
    return year, month


def parse_year(cell_value: Any) -> int | None:
    year_match = re.fullmatch(r"([0-9]{4})(?:[.,]0+)?", cell_text(cell_value))
    if not year_match:
        return None
    period = valid_period(int(year_match.group(1)), None)
    return period[0] if period else None


def parse_month(cell_value: Any) -> int | None:
    month_text = normalized_sheet_title(cell_text(cell_value)).rstrip(".")
    number_match = re.fullmatch(r"([0-9]{1,2})(?:[.,]0+)?", month_text)
    if number_match:
        month = int(number_match.group(1))
        return month if 1 <= month <= 12 else None
    return month_numbers_by_name.get(month_text)


def parse_date_period(cell_value: Any) -> tuple[int, int | None] | None:
    date_text = normalized_sheet_title(cell_text(cell_value))
    if not date_text:
        return None
    patterns: list[tuple[str, tuple[int, int]]] = [
        (r"([0-9]{4})-([0-9]{1,2})(?:-[0-9]{1,2})?(?:[t ].*)?", (1, 2)),
        (r"[0-9]{1,2}[/.-]([0-9]{1,2})[/.-]([0-9]{4})(?: .*)?", (2, 1)),
        (r"([0-9]{1,2})[/.-]([0-9]{4})", (2, 1)),
        (r"([0-9]{4})[/.]([0-9]{1,2})", (1, 2)),
        (r"([0-9]{4})([0-9]{2})", (1, 2)),
    ]
    for pattern, (year_group, month_group) in patterns:
        date_match = re.fullmatch(pattern, date_text)
        if date_match:
            return valid_period(int(date_match.group(year_group)), int(date_match.group(month_group)))
    named_match = re.fullmatch(r"([a-z]+)\.?(?:\s+de\s+|[\s/_-]+)([0-9]{2}|[0-9]{4})", date_text)
    if named_match and named_match.group(1) in month_numbers_by_name:
        year_text = named_match.group(2)
        year = int(year_text) + 2000 if len(year_text) == 2 else int(year_text)
        return valid_period(year, month_numbers_by_name[named_match.group(1)])
    year = parse_year(date_text)
    return (year, None) if year else None


def parse_numeric_value(cell_value: Any) -> str | None:
    if isinstance(cell_value, bool):
        return None
    if isinstance(cell_value, (int, float)):
        numeric_text = format(Decimal(str(cell_value)), "f")
    else:
        numeric_text = cell_text(cell_value).replace(" ", "").replace("\u00a0", "").removesuffix("%")
        if re.fullmatch(r"-?[0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]+)?|-?[0-9]+,[0-9]+", numeric_text):
            numeric_text = numeric_text.replace(".", "").replace(",", ".")
        elif re.fullmatch(r"-?[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?", numeric_text):
            numeric_text = numeric_text.replace(",", "")
        try:
            numeric_text = format(Decimal(numeric_text), "f") if re.fullmatch(r"-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?", numeric_text) else ""
        except InvalidOperation:
            return None
    if not numeric_text or numeric_text in {"NaN", "Infinity", "-Infinity"}:
        return None
    if "." in numeric_text:
        numeric_text = numeric_text.rstrip("0").rstrip(".")
    return numeric_text or "0"


def validate_period_selection(period: PeriodSelection) -> None:
    required_fields = {"year_column": ["year_field"], "date_column": ["date_field"], "month_year_columns": ["year_field", "month_field"], "fixed": ["fixed_year"], "prepared": []}[period.mode]
    if any(not getattr(period, field_name) for field_name in required_fields):
        raise HTTPException(422, "Informe todas as colunas ou valores pedidos para o período.")
    if period.mode == "fixed":
        if not valid_period(period.fixed_year or 0, period.fixed_month if period.granularity == "month" else None):
            raise HTTPException(422, "Informe um ano entre 1900 e 2200 e, para dados mensais, um mês de 1 a 12.")
        if period.granularity == "month" and not period.fixed_month:
            raise HTTPException(422, "Para dados mensais, informe também o mês.")


def resolve_row_period(source_row: dict[str, Any], period: PeriodSelection) -> tuple[tuple[int, int | None] | None, str]:
    if period.mode == "fixed":
        return (period.fixed_year or 0, period.fixed_month if period.granularity == "month" else None), ""
    if period.mode == "year_column":
        original_value = source_row.get(period.year_field or "")
        year = parse_year(original_value)
        return ((year, None) if year else None), cell_text(original_value)
    if period.mode == "month_year_columns":
        year = parse_year(source_row.get(period.year_field or ""))
        month = parse_month(source_row.get(period.month_field or ""))
        original_value = f"{cell_text(source_row.get(period.month_field or ''))}/{cell_text(source_row.get(period.year_field or ''))}"
        return ((year, month) if year and month else None), original_value
    original_value = source_row.get(period.date_field or "")
    parsed_period = parse_date_period(original_value)
    if parsed_period and period.granularity == "year":
        parsed_period = (parsed_period[0], None)
    if parsed_period and period.granularity == "month" and parsed_period[1] is None:
        parsed_period = None
    return parsed_period, cell_text(original_value)


approval_municipality_field = "approval_municipality_ibge_code"


def prepare_rows_for_approval(staged_rows: list[dict[str, Any]], period: PeriodSelection, value_field: str, municipality_field: str | None = None, resolve_municipality: Any = None) -> tuple[list[tuple[dict[str, Any], dict[str, Any]]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    prepared_rows: list[tuple[dict[str, Any], dict[str, Any]]] = []
    period_problems: list[dict[str, Any]] = []
    value_problems: list[dict[str, Any]] = []
    municipality_problems: list[dict[str, Any]] = []
    for staged_row in staged_rows:
        normalized_row = dict(staged_row.get("normalized_row") or {})
        source_row = {**(staged_row.get("raw_row") or {}), **normalized_row}
        if municipality_field and resolve_municipality:
            resolved_code = resolve_municipality(source_row.get(municipality_field))
            normalized_row[approval_municipality_field] = resolved_code
            if not resolved_code:
                municipality_problems.append({"row_number": staged_row["row_number"], "value": cell_text(source_row.get(municipality_field))})
        if period.mode != "prepared":
            normalized_row.pop("reference_year", None)
            normalized_row.pop("reference_period", None)
            row_period, original_period = resolve_row_period(source_row, period)
            if row_period:
                normalized_row["reference_year"] = str(row_period[0])
                if row_period[1]:
                    normalized_row["reference_period"] = f"{row_period[0]}-{row_period[1]:02d}-01"
            else:
                period_problems.append({"row_number": staged_row["row_number"], "value": original_period})
        original_value = source_row.get(value_field)
        normalized_row["value"] = parse_numeric_value(original_value)
        if normalized_row["value"] is None and cell_text(original_value):
            value_problems.append({"row_number": staged_row["row_number"], "value": cell_text(original_value)})
        prepared_rows.append((staged_row, normalized_row))
    return prepared_rows, period_problems, value_problems, municipality_problems


def annual_period_from_column_name(column_name: str) -> int | None:
    if monthly_period_from_column_name(column_name):
        return None
    year_match = re.search(r"(?:^|_)((?:19|20)[0-9]{2})(?:_|$)", normalized_sheet_title(normalize_column(column_name)))
    return int(year_match.group(1)) if year_match else None


def monthly_period_from_column_name(column_name: str) -> tuple[int, int] | None:
    normalized_name = normalized_sheet_title(normalize_column(column_name))
    period_match = re.search(r"(?:^|_)(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)_((?:19|20)[0-9]{2})(?:_|$)", normalized_name)
    return (int(period_match.group(2)), month_numbers_by_name[period_match.group(1)]) if period_match else None


@app.post("/imports/{import_id}/normalize-wide")
def normalize_wide_period_import(import_id: str, transformation: WideMunicipalTransform) -> dict[str, Any]:
    monthly_period = monthly_period_from_column_name(transformation.value_field)
    annual_year = None if monthly_period else annual_period_from_column_name(transformation.value_field)
    if not monthly_period and not annual_year:
        raise HTTPException(422, "O título da coluna escolhida não informa um período. Escolha uma coluna como julho_2026 ou valor_2021.")
    reference_year = monthly_period[0] if monthly_period else annual_year
    reference_month = monthly_period[1] if monthly_period else None
    staged_rows = fetch_rows_for_municipality_resolution(import_id, transformation.sheet_name)
    updated_rows: list[tuple[dict[str, Any], dict[str, Any]]] = []
    transformed_rows = 0
    for staged_row in staged_rows:
        normalized_row = {key: value for key, value in (staged_row.get("normalized_row") or {}).items() if key not in {"reference_year", "reference_period", "value", "source_measure"}}
        source_row = {**(staged_row.get("raw_row") or {}), **(staged_row.get("normalized_row") or {})}
        municipality_code = cell_text(source_row.get(transformation.municipality_field))
        measure_value = parse_numeric_value(source_row.get(transformation.value_field))
        if re.fullmatch(r"[0-9]{7}", municipality_code) and measure_value is not None:
            normalized_row.update({"municipality_ibge_code": municipality_code, "reference_year": str(reference_year), "value": measure_value, "source_measure": transformation.value_field})
            if reference_month:
                normalized_row["reference_period"] = f"{reference_year}-{reference_month:02d}-01"
            transformed_rows += 1
        updated_rows.append((staged_row, normalized_row))
    upsert_staged_rows(import_id, transformation.sheet_name, updated_rows, "Não foi possível guardar a versão normalizada das linhas.")
    return {
        "import_id": import_id,
        "municipality_field": "municipality_ibge_code",
        "year_field": "reference_year",
        "value_field": "value",
        "granularity": "month" if reference_month else "year",
        "reference_period": f"{reference_year}-{reference_month:02d}-01" if reference_month else str(reference_year),
        "transformed_rows": transformed_rows,
        "skipped_rows": len(staged_rows) - transformed_rows,
    }


class PeriodExpansion(BaseModel):
    sheet_name: str | None = None
    municipality_field: str
    measure_label: str
    period_fields: list[str] = Field(min_length=1)


identity_column_names = {"uf", "sigla_uf", "estado", "municipio", "nome_municipio", "nome_do_municipio", "cidade"}


def period_column_descriptor(column_name: str) -> dict[str, Any] | None:
    monthly_period = monthly_period_from_column_name(column_name)
    if monthly_period:
        return {"field": column_name, "year": monthly_period[0], "month": monthly_period[1]}
    annual_year = annual_period_from_column_name(column_name)
    return {"field": column_name, "year": annual_year, "month": None} if annual_year else None


@app.post("/imports/{import_id}/expand-periods")
def expand_import_periods(import_id: str, expansion: PeriodExpansion) -> dict[str, Any]:
    period_columns = [descriptor for descriptor in (period_column_descriptor(field_name) for field_name in expansion.period_fields) if descriptor]
    if len(period_columns) != len(expansion.period_fields):
        raise HTTPException(422, "Uma das colunas escolhidas não informa mês e ano ou ano no título.")
    source_sheet = expansion.sheet_name or "Dados"
    measure_label = re.sub(r"\s+", " ", expansion.measure_label).strip()[:60] or "medida"
    target_sheet = f"{source_sheet} · {measure_label} por período"
    ensure_municipal_catalog_registered()
    sheets_response = httpx.get(supabase_url("/rest/v1/import_sheets"), params={"import_id": f"eq.{import_id}", "select": "sheet_name,sheet_position,columns_profile"}, headers=supabase_headers(), timeout=30.0)
    if not sheets_response.is_success:
        raise upstream_error("Não foi possível ler as abas desta importação.", sheets_response)
    sheet_records = sheets_response.json()
    if not any(record["sheet_name"] == source_sheet for record in sheet_records):
        import_response = httpx.get(supabase_url("/rest/v1/imports"), params={"id": f"eq.{import_id}", "select": "profile,total_rows"}, headers=supabase_headers(), timeout=30.0)
        import_record = (import_response.json() or [{}])[0] if import_response.is_success else {}
        import_profile = import_record.get("profile") or {}
        source_record = {"import_id": import_id, "sheet_name": source_sheet, "sheet_position": 1, "row_count": int(import_record.get("total_rows") or 0), "column_count": len(import_profile.get("columns") or []), "columns_profile": import_profile.get("columns") or [], "sample_rows": import_profile.get("sample") or [], "selected_for_treatment": True}
        source_sheet_response = httpx.post(supabase_url("/rest/v1/import_sheets"), params={"on_conflict": "import_id,sheet_name"}, headers=supabase_headers("resolution=merge-duplicates,return=minimal"), json=[source_record], timeout=30.0)
        if not source_sheet_response.is_success:
            raise upstream_error("Não foi possível registrar a aba de origem desta importação.", source_sheet_response)
        sheet_records.append({"sheet_name": source_sheet, "sheet_position": 1, "columns_profile": source_record["columns_profile"]})
    source_columns = next((record.get("columns_profile") or [] for record in sheet_records if record["sheet_name"] == source_sheet), [])
    identity_fields = list(dict.fromkeys([expansion.municipality_field, *[column["name"] for column in source_columns if column.get("name") in identity_column_names or is_municipality_code_column(str(column.get("name", "")))]]))
    expansion_response = httpx.post(supabase_url("/rest/v1/rpc/expand_import_periods"), headers=supabase_headers(), json={"selected_import_id": import_id, "source_sheet_name": source_sheet, "target_sheet_name": target_sheet, "selected_municipality_field": expansion.municipality_field, "identity_fields": identity_fields, "period_columns": period_columns}, timeout=300.0)
    if expansion_response.status_code == 404:
        raise HTTPException(503, "Execute a migration 0016_expand_import_periods.sql no Supabase para transformar todos os períodos de uma vez.")
    if not expansion_response.is_success:
        raise upstream_error("Não foi possível criar a aba com os períodos.", expansion_response)
    outcome = expansion_response.json()[0]
    sample_response = httpx.get(supabase_url("/rest/v1/import_rows"), params={"import_id": f"eq.{import_id}", "sheet_name": f"eq.{target_sheet}", "select": "raw_row", "order": "row_number.asc", "limit": "20"}, headers=supabase_headers(), timeout=30.0)
    sample_rows = [record.get("raw_row") or {} for record in sample_response.json()] if sample_response.is_success else []
    sample_table = pl.from_dicts(sample_rows, infer_schema_length=20, strict=False) if sample_rows else pl.DataFrame()
    existing_position = next((record["sheet_position"] for record in sheet_records if record["sheet_name"] == target_sheet), None)
    sheet_record = {
        "import_id": import_id,
        "sheet_name": target_sheet,
        "sheet_position": existing_position or max([record["sheet_position"] for record in sheet_records] or [0]) + 1,
        "row_count": outcome["created_rows"],
        "column_count": sample_table.width,
        "columns_profile": [{"name": column_name, "dtype": str(sample_table[column_name].dtype), "null_count": int(sample_table[column_name].null_count())} for column_name in sample_table.columns],
        "sample_rows": sample_rows,
        "selected_for_treatment": False,
    }
    sheet_response = httpx.post(supabase_url("/rest/v1/import_sheets"), params={"on_conflict": "import_id,sheet_name"}, headers=supabase_headers("resolution=merge-duplicates,return=minimal"), json=[sheet_record], timeout=30.0)
    if not sheet_response.is_success:
        raise upstream_error("As linhas foram criadas, mas não foi possível registrar a nova aba.", sheet_response)
    return {"import_id": import_id, "sheet_name": target_sheet, "periods": len(period_columns), "granularity": "month" if any(column["month"] for column in period_columns) else "year", **outcome}


@app.get("/ibge-municipalities")
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
            rows_response = httpx.get(supabase_url("/rest/v1/import_rows"), params=query_params, headers=supabase_headers(), timeout=30.0)
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


@app.get("/imports/{import_id}/validation-issues")
def list_import_validation_issues(import_id: str) -> list[dict[str, Any]]:
    validation_issues: list[dict[str, Any]] = []
    page_size = 1000
    page_offset = 0
    while True:
        issues_response = httpx.get(
            supabase_url("/rest/v1/validation_issues"),
            params={"import_id": f"eq.{import_id}", "select": "severity,row_number,field,message,created_at", "order": "row_number.asc,created_at.desc", "limit": str(page_size), "offset": str(page_offset)},
            headers=supabase_headers(),
            timeout=30.0,
        )
        if not issues_response.is_success:
            raise HTTPException(502, "Não foi possível carregar as pendências desta importação.")
        current_page = issues_response.json()
        validation_issues.extend(current_page)
        if len(current_page) < page_size:
            return validation_issues
        page_offset += page_size


@app.get("/imports/{import_id}/sheets")
def list_import_sheets(import_id: str, sheet_name: str | None = None) -> dict[str, Any]:
    sheets_response = httpx.get(
        supabase_url("/rest/v1/import_sheets"),
        params={"import_id": f"eq.{import_id}", "select": "sheet_name,sheet_position,row_count,column_count,columns_profile,sample_rows,selected_for_treatment", "order": "sheet_position.asc"},
        headers=supabase_headers(),
        timeout=30.0,
    )
    if not sheets_response.is_success:
        raise HTTPException(502, "Não foi possível carregar as abas desta importação.")
    sheet_records = sheets_response.json()
    selected_record = next((record for record in sheet_records if record["sheet_name"] == sheet_name), None)
    if sheet_name and not selected_record:
        raise HTTPException(404, "A aba escolhida não faz parte desta importação.")
    profile = None
    if selected_record:
        stored_columns = selected_record.get("columns_profile") or []
        stored_sample = selected_record.get("sample_rows") or []
        if stored_columns and stored_sample:
            profile = {"columns": stored_columns, "sample": stored_sample}
        else:
            rows_response = httpx.get(
                supabase_url("/rest/v1/import_rows"),
                params={"import_id": f"eq.{import_id}", "sheet_name": f"eq.{sheet_name}", "select": "raw_row", "order": "row_number.asc", "limit": "20"},
                headers=supabase_headers(),
                timeout=30.0,
            )
            if not rows_response.is_success:
                raise HTTPException(502, "Não foi possível carregar uma prévia da aba escolhida.")
            sample_rows = [record.get("raw_row") or {} for record in rows_response.json()]
            if sample_rows:
                sample_table = pl.from_dicts(sample_rows, infer_schema_length=20, strict=False)
                profile = {
                    "columns": [{"name": column_name, "dtype": str(sample_table[column_name].dtype), "null_count": int(sample_table[column_name].null_count())} for column_name in sample_table.columns],
                    "sample": sample_rows,
                    "suggestions": suggest_mapping(sample_table),
                    "indicator_recommendations": recommend_indicators(sample_table),
                }
    return {
        "sheets": [{"name": record["sheet_name"], "rows": record["row_count"], "columns": record["column_count"], "has_data": record["row_count"] > 0, "imported": record["row_count"] > 0} for record in sheet_records],
        "profile": profile,
    }


@app.get("/imports/{import_id}/resume")
def resume_import(import_id: str) -> dict[str, Any]:
    import_response = httpx.get(
        supabase_url("/rest/v1/imports"),
        params={"id": f"eq.{import_id}", "select": "id,file_name,source_url,profile,status,total_rows"},
        headers=supabase_headers(),
        timeout=30.0,
    )
    if not import_response.is_success or not import_response.json():
        raise HTTPException(404, "Não encontramos essa importação salva.")
    import_record = import_response.json()[0]
    saved_profile = import_record.get("profile") or {}
    selected_sheet = saved_profile.get("selected_sheet")
    sheet_data = list_import_sheets(import_id, selected_sheet)
    resumed_profile = {**saved_profile, "sheets": sheet_data["sheets"]}
    if selected_sheet and sheet_data["profile"]:
        resumed_profile.update(sheet_data["profile"])
    return {"import_id": import_id, "status": import_record["status"], "profile": resumed_profile}


@app.post("/imports/{import_id}/include-sheets")
def include_remaining_import_sheets(import_id: str) -> dict[str, Any]:
    import_response = httpx.get(
        supabase_url("/rest/v1/imports"),
        params={"id": f"eq.{import_id}", "select": "storage_path,file_name,profile,total_rows"},
        headers=supabase_headers(),
        timeout=30.0,
    )
    if not import_response.is_success or not import_response.json():
        raise HTTPException(404, "Importação não encontrada.")
    import_record = import_response.json()[0]
    storage_path = import_record.get("storage_path")
    if not storage_path:
        raise HTTPException(422, "O arquivo original não está disponível para importar outras abas.")
    file_response = httpx.get(
        supabase_url(f"/storage/v1/object/source-files/{quote(storage_path, safe='/')}"),
        headers=supabase_headers(),
        timeout=180.0,
    )
    if not file_response.is_success:
        raise HTTPException(502, "Não foi possível abrir o arquivo original para importar as outras abas.")
    existing_response = httpx.get(
        supabase_url("/rest/v1/import_sheets"),
        params={"import_id": f"eq.{import_id}", "select": "sheet_name,row_count"},
        headers=supabase_headers(),
        timeout=30.0,
    )
    if not existing_response.is_success:
        raise HTTPException(502, "Não foi possível verificar quais abas já foram importadas.")
    existing_rows = {record["sheet_name"]: record["row_count"] for record in existing_response.json()}
    file_name = import_record["file_name"]
    original_profile = import_record.get("profile") or {}
    selected_sheet = original_profile.get("selected_sheet")
    source_tables = import_tables(file_name, file_response.content, selected_sheet, True)
    pending_tables = [(name, table) for name, table in source_tables if not existing_rows.get(name)]
    staged_rows = [
        {"import_id": import_id, "sheet_name": table_name, "row_number": row_number, "raw_row": row_values}
        for table_name, table in pending_tables
        for row_number, row_values in enumerate(table.to_dicts(), start=1)
    ]
    for start_index in range(0, len(staged_rows), 500):
        rows_response = httpx.post(
            supabase_url("/rest/v1/import_rows"),
            headers=supabase_headers("resolution=ignore-duplicates"),
            json=staged_rows[start_index:start_index + 500],
            timeout=60.0,
        )
        if not rows_response.is_success:
            raise HTTPException(502, "Não foi possível guardar as linhas das abas adicionais.")
    sheet_records = []
    for sheet_position, (table_name, table) in enumerate(source_tables, start=1):
        sheet_records.append({
            "import_id": import_id,
            "sheet_name": table_name,
            "sheet_position": sheet_position,
            "row_count": table.height,
            "column_count": table.width,
            "columns_profile": [{"name": column_name, "dtype": str(table[column_name].dtype), "null_count": int(table[column_name].null_count())} for column_name in table.columns],
            "sample_rows": table.head(20).to_dicts(),
            "selected_for_treatment": False,
        })
    sheets_response = httpx.post(
        supabase_url("/rest/v1/import_sheets"),
        headers=supabase_headers("resolution=merge-duplicates"),
        json=sheet_records,
        timeout=30.0,
    )
    if not sheets_response.is_success:
        raise HTTPException(502, "As linhas foram preparadas, mas não foi possível atualizar a lista de abas.")
    additional_rows = sum(table.height for _, table in pending_tables)
    if additional_rows:
        total_rows = int(import_record.get("total_rows") or 0) + additional_rows
        total_response = httpx.patch(
            supabase_url(f"/rest/v1/imports?id=eq.{import_id}"),
            headers=supabase_headers(),
            json={"total_rows": total_rows},
            timeout=30.0,
        )
        if not total_response.is_success:
            raise HTTPException(502, "As abas foram guardadas, mas não foi possível atualizar o total de linhas.")
    return {"import_id": import_id, "added_rows": additional_rows, "added_sheets": [name for name, _ in pending_tables]}


@app.post("/imports/{import_id}/normalize-municipal-wide")
def normalize_municipal_wide_import(import_id: str, transformation: WideMunicipalTransform) -> dict[str, Any]:
    period = period_from_column_name(transformation.value_field)
    if not period:
        raise HTTPException(422, "A coluna escolhida não informa um mês e ano no título. Escolha uma coluna como julho_2026_saldos.")
    reference_year, reference_month = period
    transformation_response = httpx.post(supabase_url("/rest/v1/rpc/normalize_municipal_wide_import"), headers=supabase_headers(), json={"selected_import_id": import_id, "selected_municipality_field": transformation.municipality_field, "selected_value_field": transformation.value_field, "selected_reference_year": reference_year, "selected_reference_month": reference_month, "selected_sheet_name": transformation.sheet_name}, timeout=60.0)
    if not transformation_response.is_success:
        raise upstream_error("Não foi possível guardar a versão normalizada das linhas.", transformation_response)
    outcome = transformation_response.json()[0]
    return {"import_id": import_id, "municipality_field": "municipality_ibge_code", "year_field": "reference_year", "value_field": "value", "reference_period": f"{reference_year}-{reference_month:02d}-01", **outcome}


@app.post("/imports/{import_id}/approve")
def approve_generic_import(import_id: str, approval: GenericApproval) -> dict[str, str]:
    approval_response = httpx.post(supabase_url("/rest/v1/rpc/approve_generic_import"), headers=supabase_headers(), json={"selected_import_id": import_id, "selected_mapping": approval.mapping, "selected_explanation": approval.explanation}, timeout=30.0)
    if not approval_response.is_success:
        raise upstream_error("Não foi possível registrar a aprovação da importação.", approval_response)
    return {"import_id": import_id, "status": "approved", "proposal_id": approval_response.json()}


@app.get("/imports/{import_id}/export.csv")
def export_import_csv(import_id: str) -> Response:
    import_rows = fetch_import_rows(import_id)
    field_names = list(dict.fromkeys(field_name for import_row in import_rows for field_name in import_row["raw_row"]))
    sheet_field_name = "aba"
    suffix = 2
    while sheet_field_name in set(field_names):
        sheet_field_name = f"aba_{suffix}"
        suffix += 1
    csv_buffer = StringIO()
    csv_writer = csv.DictWriter(csv_buffer, fieldnames=[sheet_field_name, *field_names], extrasaction="ignore", delimiter=";")
    csv_writer.writeheader()
    for import_row in import_rows:
        csv_writer.writerow({sheet_field_name: import_row["sheet_name"], **{field_name: spreadsheet_export_value(field_value) for field_name, field_value in import_row["raw_row"].items()}})
    return Response("\ufeff" + csv_buffer.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="importacao-{import_id}.csv"'})


@app.get("/imports/{import_id}/export.xlsx")
def export_import_xlsx(import_id: str) -> Response:
    import_rows = fetch_import_rows(import_id)
    workbook = Workbook()
    workbook.remove(workbook.active)
    import_rows_by_sheet: dict[str, list[dict[str, Any]]] = {}
    for import_row in import_rows:
        import_rows_by_sheet.setdefault(import_row["sheet_name"], []).append(import_row)
    if not import_rows_by_sheet:
        import_rows_by_sheet["Dados"] = []
    for sheet_name, sheet_rows in import_rows_by_sheet.items():
        worksheet = workbook.create_sheet(safe_workbook_sheet_name(sheet_name, workbook.sheetnames))
        records = [import_row["raw_row"] for import_row in sheet_rows]
        field_names = list(dict.fromkeys(field_name for record in records for field_name in record))
        worksheet.append(field_names)
        for record in records:
            worksheet.append([spreadsheet_export_value(record.get(field_name)) for field_name in field_names])
        worksheet.freeze_panes = "A2"
        for column_cells in worksheet.columns:
            longest_value = max(len(str(cell.value or "")) for cell in column_cells)
            worksheet.column_dimensions[column_cells[0].column_letter].width = min(longest_value + 2, 48)
    workbook_buffer = BytesIO()
    workbook.save(workbook_buffer)
    return Response(workbook_buffer.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f'attachment; filename="importacao-{import_id}.xlsx"'})


def fetch_import_rows(import_id: str) -> list[dict[str, Any]]:
    import_rows: list[dict[str, Any]] = []
    page_size = 1000
    page_offset = 0
    while True:
        rows_response = httpx.get(
            supabase_url("/rest/v1/import_rows"),
            params={"import_id": f"eq.{import_id}", "select": "sheet_name,row_number,raw_row", "order": "sheet_name,row_number", "limit": str(page_size), "offset": str(page_offset)},
            headers=supabase_headers(),
            timeout=30.0,
        )
        if not rows_response.is_success:
            raise HTTPException(502, "Não foi possível preparar a exportação.")
        current_page = rows_response.json()
        import_rows.extend(current_page)
        if len(current_page) < page_size:
            return import_rows
        page_offset += page_size


def safe_workbook_sheet_name(sheet_name: str, existing_names: list[str]) -> str:
    sanitized_name = re.sub(r"[\\/*?:\[\]]", " ", sheet_name).strip()[:31] or "Dados"
    candidate_name = sanitized_name
    suffix = 2
    while candidate_name.casefold() in {existing_name.casefold() for existing_name in existing_names}:
        suffix_text = f" ({suffix})"
        candidate_name = f"{sanitized_name[:31 - len(suffix_text)]}{suffix_text}"
        suffix += 1
    return candidate_name


def spreadsheet_export_value(field_value: Any) -> Any:
    if isinstance(field_value, (dict, list)):
        return json.dumps(field_value, ensure_ascii=False, separators=(",", ":"))
    return field_value
