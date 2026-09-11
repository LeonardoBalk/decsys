import gzip
import ipaddress
import json
import os
import re
import socket
import csv
import zipfile
from hashlib import sha256
from io import BytesIO, StringIO
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse

import httpx
import polars as pl
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from openpyxl import Workbook, load_workbook
from openai import OpenAI
from pydantic import BaseModel, HttpUrl

load_dotenv(Path(__file__).parents[1] / ".env")

app = FastAPI(title="Decsys Ingestion API", version="0.2.0")
ai_assessment_size_limit = 20 * 1024 * 1024
supported_extensions = {".csv", ".xlsx", ".xls", ".json"}
archive_extensions = {".zip", ".gz"}
acceptable_extensions = supported_extensions | archive_extensions
maximum_redirect_hops = 5


class LinkRequest(BaseModel):
    source_url: HttpUrl
    dataset_id: str | None = None
    title: str | None = None
    reference_year: int | None = None
    sheet_name: str | None = None


class ImportDecision(BaseModel):
    decision: str


class MunicipalApproval(BaseModel):
    indicator_id: str
    municipality_field: str
    year_field: str
    value_field: str
    unit: str


class GenericApproval(BaseModel):
    mapping: dict[str, Any]
    explanation: str


def supabase_headers(prefer: str | None = None) -> dict[str, str]:
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not service_role_key:
        raise HTTPException(500, "Configure SUPABASE_SERVICE_ROLE_KEY no serviço de ingestão.")
    request_headers = {"apikey": service_role_key, "Authorization": f"Bearer {service_role_key}"}
    if prefer:
        request_headers["Prefer"] = prefer
    return request_headers


def supabase_url(path: str) -> str:
    project_url = os.getenv("SUPABASE_URL")
    if not project_url:
        raise HTTPException(500, "Configure SUPABASE_URL no serviço de ingestão.")
    return f"{project_url}{path}"


def persist_import(source_name: str, source_content: bytes, source_url: str | None, dataset_id: str, import_title: str, reference_year: int | None, sheet_name: str | None = None) -> dict[str, Any]:
    selected_sheet = resolve_sheet_name(source_name, source_content, sheet_name)
    source_table = read_table(source_name, source_content, selected_sheet)
    source_table = source_table.rename({column_name: normalize_column(column_name) for column_name in source_table.columns})
    source_profile = profile_table(source_name, source_content, source_url, "uploaded_file" if source_url is None else "remote_file", selected_sheet)
    source_record = {"name": source_name, "base_url": source_url}
    source_response = httpx.post(supabase_url("/rest/v1/sources"), headers=supabase_headers("return=representation"), json=source_record, timeout=30.0)
    if not source_response.is_success:
        raise HTTPException(502, "Não foi possível registrar a fonte no Supabase.")
    source_id = source_response.json()[0]["id"]
    import_response = httpx.post(supabase_url("/rest/v1/imports"), headers=supabase_headers("return=representation"), json={"source_id": source_id, "dataset_id": dataset_id, "title": import_title, "reference_year": reference_year, "source_url": source_url, "file_name": source_name, "file_sha256": sha256(source_content).hexdigest(), "status": "needs_review", "profile": source_profile, "total_rows": source_table.height}, timeout=30.0)
    if not import_response.is_success:
        raise HTTPException(502, "Não foi possível criar o rascunho da importação no Supabase.")
    import_record = import_response.json()[0]
    import_id = import_record["id"]
    if selected_sheet:
        sheet_records = []
        for sheet_position, sheet in enumerate(workbook_sheets(source_content), start=1):
            is_selected = sheet["name"] == selected_sheet
            sheet_records.append({"import_id": import_id, "sheet_name": sheet["name"], "sheet_position": sheet_position, "row_count": sheet["rows"], "column_count": sheet["columns"], "columns_profile": source_profile["columns"] if is_selected else [], "sample_rows": source_profile["sample"] if is_selected else [], "selected_for_treatment": is_selected})
        sheets_response = httpx.post(supabase_url("/rest/v1/import_sheets"), headers=supabase_headers(), json=sheet_records, timeout=30.0)
        if not sheets_response.is_success:
            raise HTTPException(502, "Não foi possível registrar as abas da planilha. Confirme se a migration 0008_import_sheets.sql foi executada no Supabase.")
    original_storage_path = f"imports/{import_id}/original/{source_name}"
    storage_response = httpx.post(supabase_url(f"/storage/v1/object/source-files/{original_storage_path}"), headers={**supabase_headers("resolution=merge-duplicates"), "Content-Type": "application/octet-stream", "x-upsert": "true"}, content=source_content, timeout=180.0)
    if not storage_response.is_success:
        raise HTTPException(502, "O rascunho foi criado, mas o arquivo não pôde ser guardado no Storage.")
    staged_rows = [{"import_id": import_id, "row_number": row_number, "raw_row": row_values} for row_number, row_values in enumerate(source_table.to_dicts(), start=1)]
    for start_index in range(0, len(staged_rows), 500):
        staged_response = httpx.post(supabase_url("/rest/v1/import_rows"), headers=supabase_headers(), json=staged_rows[start_index:start_index + 500], timeout=30.0)
        if not staged_response.is_success:
            raise HTTPException(502, "O arquivo foi guardado, mas as linhas não puderam ser preparadas para revisão.")
    update_response = httpx.patch(supabase_url(f"/rest/v1/imports?id=eq.{import_id}"), headers=supabase_headers(), json={"storage_path": original_storage_path}, timeout=30.0)
    if not update_response.is_success:
        raise HTTPException(502, "O arquivo foi guardado, mas o caminho não pôde ser associado à importação.")
    return {"import_id": import_id, "status": "needs_review", "total_rows": source_table.height, "profile": source_profile}


def normalize_column(column_name: str) -> str:
    return "_".join(column_name.strip().lower().replace("/", " ").split())


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


async def download_source(source_url: str) -> tuple[str, bytes, str, str]:
    current_url = normalize_share_link(source_url)
    validate_source_url(current_url)
    content_type = ""
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
                    accumulated_content = bytearray()
                    async for content_chunk in streamed_response.aiter_bytes():
                        accumulated_content.extend(content_chunk)
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
    source_name = Path(urlparse(final_url).path).name or "fonte-remota"
    if not Path(source_name).suffix:
        if "application/json" in content_type:
            source_name = f"{source_name}.json"
        elif "text/csv" in content_type:
            source_name = f"{source_name}.csv"
        elif "zip" in content_type:
            source_name = f"{source_name}.zip"
        elif "gzip" in content_type:
            source_name = f"{source_name}.gz"
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
    numeric_pattern = r"^-?[0-9]{1,3}(\.[0-9]{3})*(,[0-9]+)?$|^-?[0-9]+,[0-9]+$"
    normalized_columns: list[pl.Expr] = []
    for column_name, data_type in zip(source_table.columns, source_table.dtypes):
        if data_type != pl.String:
            continue
        non_empty_values = source_table[column_name].drop_nulls().str.strip_chars()
        if non_empty_values.len() and non_empty_values.str.contains(numeric_pattern).all():
            normalized_columns.append(pl.col(column_name).str.replace_all(".", "", literal=True).str.replace(",", ".", literal=True).cast(pl.Float64, strict=False).alias(column_name))
    return source_table.with_columns(normalized_columns) if normalized_columns else source_table


def workbook_sheets(source_content: bytes) -> list[dict[str, int | str]]:
    workbook = load_workbook(BytesIO(source_content), read_only=True, data_only=True)
    return [{"name": worksheet.title, "rows": worksheet.max_row, "columns": worksheet.max_column} for worksheet in workbook.worksheets]


def resolve_sheet_name(source_name: str, source_content: bytes, requested_sheet_name: str | None) -> str | None:
    if Path(source_name).suffix.lower() not in {".xlsx", ".xls"}:
        return None
    available_sheets = workbook_sheets(source_content)
    if requested_sheet_name:
        if requested_sheet_name not in {str(sheet["name"]) for sheet in available_sheets}:
            raise HTTPException(422, "A aba selecionada não existe mais nessa planilha.")
        return requested_sheet_name
    sheet_candidates = sorted(available_sheets, key=lambda worksheet: int(worksheet["rows"]) * int(worksheet["columns"]), reverse=True)
    for sheet_candidate in sheet_candidates:
        try:
            candidate_table = pl.read_excel(BytesIO(source_content), sheet_name=str(sheet_candidate["name"]), infer_schema_length=500)
            if candidate_table.height and candidate_table.width:
                return str(sheet_candidate["name"])
        except pl.exceptions.NoDataError:
            continue
    raise HTTPException(422, "Nenhuma aba da planilha contém uma tabela que possa ser lida.")


def read_table(source_name: str, source_content: bytes, sheet_name: str | None = None) -> pl.DataFrame:
    source_extension = Path(source_name).suffix.lower()
    if source_extension == ".gz":
        return read_table(Path(source_name).stem, gzip.decompress(source_content))
    if source_extension == ".zip":
        with zipfile.ZipFile(BytesIO(source_content)) as source_archive:
            candidate_members = [member for member in source_archive.namelist() if not member.endswith("/") and Path(member).suffix.lower() in supported_extensions]
            if not candidate_members:
                raise HTTPException(415, "O arquivo .zip não contém nenhum CSV, XLSX, XLS ou JSON.")
            chosen_member = candidate_members[0]
            return read_table(Path(chosen_member).name, source_archive.read(chosen_member))
    if source_extension == ".csv":
        csv_text = decode_csv_text(source_content)
        return normalize_brazilian_decimals(pl.read_csv(StringIO(csv_text), try_parse_dates=True, infer_schema_length=500, separator=detect_csv_separator(csv_text)))
    if source_extension in {".xlsx", ".xls"}:
        selected_sheet = resolve_sheet_name(source_name, source_content, sheet_name)
        return pl.read_excel(BytesIO(source_content), sheet_name=selected_sheet, infer_schema_length=500)
    if source_extension == ".json":
        return pl.read_json(BytesIO(source_content))
    raise HTTPException(415, "Formato não suportado. Envie ou indique CSV, XLSX, XLS, JSON, ou um .zip/.gz contendo um desses formatos.")


def profile_table(source_name: str, source_content: bytes, source_url: str | None, source_kind: str, sheet_name: str | None = None) -> dict[str, Any]:
    selected_sheet = resolve_sheet_name(source_name, source_content, sheet_name)
    source_table = read_table(source_name, source_content, selected_sheet)
    source_table = source_table.rename({column_name: normalize_column(column_name) for column_name in source_table.columns})
    null_counts = {column_name: int(source_table[column_name].null_count()) for column_name in source_table.columns}
    source_profile = {
        "kind": source_kind,
        "file_name": source_name,
        "source_url": source_url,
        "rows": source_table.height,
        "columns": [{"name": column_name, "dtype": str(source_table[column_name].dtype), "null_count": null_counts[column_name]} for column_name in source_table.columns],
        "sample": source_table.head(20).to_dicts(),
        "suggestions": suggest_mapping(source_table),
    }
    if Path(source_name).suffix.lower() in {".xlsx", ".xls"}:
        source_profile["sheets"] = workbook_sheets(source_content)
        source_profile["selected_sheet"] = selected_sheet
    if len(source_content) > ai_assessment_size_limit:
        source_profile["agent_assessment"] = {"status": "skipped", "summary": f"A leitura estrutural foi concluída. O arquivo tem mais de {ai_assessment_size_limit // (1024 * 1024)} MB, então a avaliação por IA foi pulada para manter a resposta rápida."}
    else:
        source_profile["agent_assessment"] = assess_source(source_profile)
    return source_profile


def suggest_mapping(source_table: pl.DataFrame) -> dict[str, str]:
    source_columns = set(source_table.columns)
    suggestions: dict[str, str] = {}
    for column_name in source_columns:
        if any(token in column_name for token in ("ibge", "cod_mun", "codigo_municip")):
            suggestions["municipality_code"] = column_name
        if column_name in {"ano", "year", "periodo", "ano_referencia"}:
            suggestions["reference_year"] = column_name
        if column_name in {"valor", "value", "indice", "percentual"}:
            suggestions["value"] = column_name
    return suggestions


def assessment_schema() -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "properties": {"summary": {"type": "string"}, "municipality_field": {"type": ["string", "null"]}, "year_field": {"type": ["string", "null"]}, "measure_field": {"type": ["string", "null"]}, "risks": {"type": "array", "items": {"type": "string"}}}, "required": ["summary", "municipality_field", "year_field", "measure_field", "risks"]}


def assessment_prompt(source_profile: dict[str, Any]) -> str:
    return "Avalie esta fonte de dados urbanos. Não invente significados de campos. Identifique somente o que estiver sustentado pelas colunas e pela amostra. A resposta será revisada por uma pessoa antes de qualquer importação. Responda somente no objeto JSON solicitado, sem encapsular em outro campo. Fonte: " + json.dumps(source_profile, ensure_ascii=False, default=str)


def assess_with_openai(source_profile: dict[str, Any]) -> dict[str, Any]:
    response = OpenAI(api_key=os.environ["OPENAI_API_KEY"]).responses.create(model=os.getenv("OPENAI_MODEL", "gpt-5-mini"), input=assessment_prompt(source_profile), text={"format": {"type": "json_schema", "name": "source_assessment", "strict": True, "schema": assessment_schema()}})
    return {"status": "available", "provider": "openai", **json.loads(response.output_text)}


def assess_with_gemini(source_profile: dict[str, Any]) -> dict[str, Any]:
    gemini_model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    gemini_response = httpx.post(f"https://generativelanguage.googleapis.com/v1beta/models/{gemini_model}:generateContent", params={"key": os.environ["GEMINI_API_KEY"]}, json={"contents": [{"role": "user", "parts": [{"text": assessment_prompt(source_profile)}]}], "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": assessment_schema(), "temperature": 0.1}}, timeout=30.0)
    gemini_response.raise_for_status()
    response_text = gemini_response.json()["candidates"][0]["content"]["parts"][0]["text"]
    return {"status": "available", "provider": "gemini", **json.loads(response_text)}


def assess_source(source_profile: dict[str, Any]) -> dict[str, Any]:
    provider = os.getenv("AI_PROVIDER", "gemini").lower()
    has_provider_key = (provider == "gemini" and os.getenv("GEMINI_API_KEY")) or (provider == "openai" and os.getenv("OPENAI_API_KEY"))
    if not has_provider_key:
        return {"status": "not_configured", "summary": f"A leitura estrutural foi concluída. Configure a chave do provedor {provider} para receber a avaliação do agente."}
    try:
        if provider == "openai":
            return assess_with_openai(source_profile)
        if provider == "gemini":
            return assess_with_gemini(source_profile)
        return {"status": "not_configured", "summary": "O provedor de IA configurado não é suportado."}
    except Exception:
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


@app.get("/indicators")
def list_indicators() -> list[dict[str, Any]]:
    indicators_response = httpx.post(supabase_url("/rest/v1/rpc/list_active_indicators"), headers=supabase_headers(), json={}, timeout=30.0)
    if not indicators_response.is_success:
        raise HTTPException(502, "Não foi possível carregar os indicadores.")
    return indicators_response.json()


@app.post("/profile")
async def profile_file(file: UploadFile = File(...), sheet_name: str | None = Form(None)) -> dict[str, Any]:
    source_content = await file.read()
    if not file.filename:
        raise HTTPException(400, "Arquivo sem nome.")
    return profile_table(file.filename, source_content, None, "uploaded_file", sheet_name)


@app.post("/profile-link")
async def profile_link(link_request: LinkRequest) -> dict[str, Any]:
    source_url = str(link_request.source_url)
    drive_target = parse_drive_url(source_url)
    if drive_target:
        drive_kind, drive_id = drive_target
        if drive_kind == "folder":
            drive_candidates = list_drive_folder(drive_id)
            if drive_candidates:
                return {"kind": "web_page", "source_url": source_url, "download_candidates": drive_candidates}
            raise HTTPException(415, "Não encontramos arquivos compatíveis nessa pasta do Google Drive, ou ela não está compartilhada publicamente.")
        source_name, source_content, _ = fetch_drive_file(drive_id)
        return profile_table(source_name, source_content, source_url, "remote_file", link_request.sheet_name)
    source_name, source_content, content_type, final_url = await download_source(source_url)
    if "text/html" in content_type or Path(source_name).suffix.lower() not in acceptable_extensions:
        ckan_candidates = discover_ckan_resources(final_url)
        if ckan_candidates:
            return {"kind": "web_page", "source_url": final_url, "download_candidates": ckan_candidates}
        munic_candidates = discover_munic_resources(final_url)
        if munic_candidates:
            return {"kind": "web_page", "source_url": final_url, "download_candidates": munic_candidates}
        download_candidates = discover_downloads(source_content, final_url)
        if download_candidates:
            return {"kind": "web_page", "source_url": final_url, "download_candidates": download_candidates}
        raise HTTPException(415, "A página não apresentou um arquivo CSV, XLSX, XLS, JSON ou ZIP identificável.")
    return profile_table(source_name, source_content, final_url, "remote_file", link_request.sheet_name)


@app.post("/imports/draft")
async def create_import_draft(file: UploadFile = File(...), dataset_id: str | None = Form(None), title: str = Form(...), reference_year: int | None = Form(None), sheet_name: str | None = Form(None)) -> dict[str, Any]:
    source_content = await file.read()
    if not file.filename:
        raise HTTPException(400, "Arquivo sem nome.")
    return persist_import(file.filename, source_content, None, dataset_id, title, reference_year, sheet_name)


@app.post("/imports/draft-link")
async def create_link_import_draft(link_request: LinkRequest) -> dict[str, Any]:
    source_url = str(link_request.source_url)
    drive_target = parse_drive_url(source_url)
    if drive_target:
        drive_kind, drive_id = drive_target
        if drive_kind == "folder":
            raise HTTPException(415, "Escolha um arquivo específico da pasta do Google Drive antes de criar o rascunho.")
        source_name, source_content, _ = fetch_drive_file(drive_id)
        return persist_import(source_name, source_content, source_url, link_request.dataset_id, link_request.title or source_name, link_request.reference_year, link_request.sheet_name)
    source_name, source_content, content_type, final_url = await download_source(source_url)
    if "text/html" in content_type or Path(source_name).suffix.lower() not in acceptable_extensions:
        raise HTTPException(415, "Use o link direto de um arquivo para criar o rascunho.")
    return persist_import(source_name, source_content, final_url, link_request.dataset_id, link_request.title or source_name, link_request.reference_year, link_request.sheet_name)


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
    approval_response = httpx.post(supabase_url("/rest/v1/rpc/approve_municipal_import"), headers=supabase_headers(), json={"selected_import_id": import_id, "selected_indicator_id": approval.indicator_id, "municipality_field": approval.municipality_field, "year_field": approval.year_field, "value_field": approval.value_field, "observation_unit": approval.unit}, timeout=30.0)
    if not approval_response.is_success:
        raise HTTPException(502, "Não foi possível aprovar a importação municipal.")
    return {"import_id": import_id, "status": "approved", "approved_rows": approval_response.json()}


@app.post("/imports/{import_id}/approve")
def approve_generic_import(import_id: str, approval: GenericApproval) -> dict[str, str]:
    approval_response = httpx.post(supabase_url("/rest/v1/rpc/approve_generic_import"), headers=supabase_headers(), json={"selected_import_id": import_id, "selected_mapping": approval.mapping, "selected_explanation": approval.explanation}, timeout=30.0)
    if not approval_response.is_success:
        raise HTTPException(502, "Não foi possível registrar a aprovação da importação.")
    return {"import_id": import_id, "status": "approved", "proposal_id": approval_response.json()}


@app.get("/imports/{import_id}/export.csv")
def export_import_csv(import_id: str) -> Response:
    rows_response = httpx.get(supabase_url("/rest/v1/import_rows"), params={"import_id": f"eq.{import_id}", "select": "raw_row", "order": "row_number"}, headers=supabase_headers(), timeout=30.0)
    if not rows_response.is_success:
        raise HTTPException(502, "Não foi possível preparar a exportação.")
    records = [entry["raw_row"] for entry in rows_response.json()]
    field_names = list(dict.fromkeys(field_name for record in records for field_name in record))
    csv_buffer = StringIO()
    csv_writer = csv.DictWriter(csv_buffer, fieldnames=field_names, extrasaction="ignore", delimiter=";")
    csv_writer.writeheader()
    csv_writer.writerows(records)
    return Response("\ufeff" + csv_buffer.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="importacao-{import_id}.csv"'})


@app.get("/imports/{import_id}/export.xlsx")
def export_import_xlsx(import_id: str) -> Response:
    rows_response = httpx.get(supabase_url("/rest/v1/import_rows"), params={"import_id": f"eq.{import_id}", "select": "raw_row", "order": "row_number"}, headers=supabase_headers(), timeout=30.0)
    if not rows_response.is_success:
        raise HTTPException(502, "Não foi possível preparar a exportação.")
    records = [entry["raw_row"] for entry in rows_response.json()]
    field_names = list(dict.fromkeys(field_name for record in records for field_name in record))
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "Dados"
    worksheet.append(field_names)
    for record in records:
        worksheet.append([record.get(field_name) for field_name in field_names])
    worksheet.freeze_panes = "A2"
    for column_cells in worksheet.columns:
        longest_value = max(len(str(cell.value or "")) for cell in column_cells)
        worksheet.column_dimensions[column_cells[0].column_letter].width = min(longest_value + 2, 48)
    workbook_buffer = BytesIO()
    workbook.save(workbook_buffer)
    return Response(workbook_buffer.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f'attachment; filename="importacao-{import_id}.xlsx"'})
