import httpx
import ipaddress
import os
import re
import socket
from bs4 import BeautifulSoup
from email.message import Message
from fastapi import HTTPException
from pathlib import Path
from starlette.concurrency import run_in_threadpool
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse

from .config import acceptable_extensions, maximum_redirect_hops
from .source_limits import ensure_source_size


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

def is_download_in_gov_br_page_context(page_url: str, download_url: str) -> bool:
    page_address = urlparse(page_url)
    download_address = urlparse(download_url)
    if page_address.hostname != download_address.hostname or not page_address.hostname or not page_address.hostname.endswith("gov.br"):
        return True
    page_sections = [section.lower() for section in page_address.path.split("/") if section and section.lower() != "pt-br"]
    download_sections = [section.lower() for section in download_address.path.split("/") if section and section.lower() != "pt-br"]
    shared_sections = 0
    for page_section, download_section in zip(page_sections, download_sections):
        if page_section != download_section:
            break
        shared_sections += 1
    return shared_sections >= 2

def discover_downloads(page_content: bytes, page_url: str) -> list[dict[str, str]]:
    document = BeautifulSoup(page_content, "html.parser")
    downloads: list[dict[str, str]] = []
    for link_element in document.select("a[href]"):
        candidate_url = urljoin(page_url, str(link_element.get("href")))
        candidate_name = Path(urlparse(candidate_url).path).name
        if urlparse(candidate_url).scheme in {"http", "https"} and Path(candidate_name).suffix.lower() in acceptable_extensions and is_download_in_gov_br_page_context(page_url, candidate_url):
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
            if group_name:
                facet_filter = f"groups:{group_name}"
            else:
                escaped_tag = (tag_name or "").replace('"', '\\"')
                facet_filter = f'tags:"{escaped_tag}"' if any(character.isspace() for character in escaped_tag) else f"tags:{escaped_tag}"
            search_response = httpx.get(f"{parsed_url.scheme}://{parsed_url.netloc}/api/3/action/package_search", params={"fq": facet_filter, "rows": 100}, timeout=15.0)
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
    parsed_url = urlparse(page_url)
    is_ibge_host = bool(parsed_url.hostname and parsed_url.hostname.endswith("ibge.gov.br"))
    munic_page_tokens = ("10586-", "pesquisa-de-informacoes-basicas-municipais", "perfil_municipios")
    if not is_ibge_host or not any(token in parsed_url.path.lower() for token in munic_page_tokens):
        return []
    try:
        ftp_response = httpx.get("https://ftp.ibge.gov.br/Perfil_Municipios/2024/Base_de_Dados/", timeout=20.0)
        ftp_response.raise_for_status()
    except httpx.HTTPError:
        return []
    return discover_downloads(ftp_response.content, str(ftp_response.url))

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
    # As páginas do IBGE ficam atrás de WAF e respondem 403 a clientes automatizados; a base da MUNIC é lida direto do FTP.
    is_direct_file = Path(urlparse(source_url).path).suffix.lower() in acceptable_extensions
    munic_candidates = [] if is_direct_file else await run_in_threadpool(discover_munic_resources, source_url)
    if munic_candidates:
        return "", b"", "", source_url, munic_candidates
    source_name, source_content, content_type, final_url = await download_source(source_url)
    return source_name, source_content, content_type, final_url, None

def is_page_response(source_name: str, content_type: str) -> bool:
    return "text/html" in content_type or Path(source_name).suffix.lower() not in acceptable_extensions

def discover_page_candidates(page_content: bytes, page_url: str) -> list[dict[str, str]]:
    return discover_ckan_resources(page_url) or discover_munic_resources(page_url) or discover_downloads(page_content, page_url)
