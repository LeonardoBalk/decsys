import threading
import time
import uuid
from fastapi import HTTPException
from typing import Any

from . import config, import_store
from .config import source_cache_ttl_seconds
from .table_reading import profile_table


source_cache: dict[str, dict[str, Any]] = {}

source_cache_lock = threading.Lock()

def remember_source(source_name: str, source_content: bytes, source_url: str | None) -> str:
    upload_token = uuid.uuid4().hex
    current_time = time.time()
    with source_cache_lock:
        for expired_token in [token for token, entry in source_cache.items() if entry["expires_at"] < current_time]:
            del source_cache[expired_token]
        source_cache[upload_token] = {"name": source_name, "content": source_content, "source_url": source_url, "expires_at": current_time + source_cache_ttl_seconds, "profiles": {}}
        cached_bytes = sum(len(entry["content"]) for entry in source_cache.values())
        for oldest_token in sorted(source_cache, key=lambda token: source_cache[token]["expires_at"]):
            if cached_bytes <= config.source_cache_max_bytes or oldest_token == upload_token:
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
    return import_store.persist_import(entry["name"], entry["content"], entry["source_url"], dataset_id, import_title or entry["name"], reference_year, sheet_name, include_all_sheets, entry["profiles"])
