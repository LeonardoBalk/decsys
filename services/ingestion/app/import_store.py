import httpx
import json
import polars as pl
import re
from fastapi import HTTPException
from hashlib import sha256
from typing import Any
from urllib.parse import quote

from . import supabase_client, table_reading
from .supabase_client import upstream_error
from .table_reading import json_compatible_value, profile_table, workbook_sheets


def discard_partial_import(source_id: str | None, import_id: str | None, storage_path: str | None) -> None:
    cleanup_requests = []
    if storage_path:
        cleanup_requests.append(lambda: httpx.delete(supabase_client.supabase_url(f"/storage/v1/object/source-files/{quote(storage_path, safe='/')}"), headers=supabase_client.supabase_headers(), timeout=30.0))
    if import_id:
        cleanup_requests.append(lambda: httpx.delete(supabase_client.supabase_url("/rest/v1/imports"), params={"id": f"eq.{import_id}"}, headers=supabase_client.supabase_headers(), timeout=30.0))
    if source_id:
        cleanup_requests.append(lambda: httpx.delete(supabase_client.supabase_url("/rest/v1/sources"), params={"id": f"eq.{source_id}"}, headers=supabase_client.supabase_headers(), timeout=30.0))
    for cleanup_request in cleanup_requests:
        try:
            cleanup_request()
        except Exception:
            continue

def persist_import(source_name: str, source_content: bytes, source_url: str | None, dataset_id: str | None, import_title: str, reference_year: int | None, sheet_name: str | None = None, include_all_sheets: bool = False, cached_profiles: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    selected_sheet = sheet_name
    cached_source_profile = (cached_profiles or {}).get(selected_sheet or "")
    if include_all_sheets and not selected_sheet and cached_profiles:
        cached_source_profile = next((profile for profile in cached_profiles.values() if profile.get("selected_sheet")), None)
        selected_sheet = cached_source_profile.get("selected_sheet") if cached_source_profile else None
    if not selected_sheet:
        selected_sheet = table_reading.resolve_sheet_name(source_name, source_content, sheet_name)
    selected_tables = table_reading.import_tables(source_name, source_content, selected_sheet, include_all_sheets)
    source_profile = cached_source_profile or (cached_profiles or {}).get(selected_sheet or "")
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
    source_profile = json_compatible_value({key: value for key, value in source_profile.items() if key != "upload_token"})
    source_record = {"name": source_name, "base_url": source_url}
    source_response = httpx.post(supabase_client.supabase_url("/rest/v1/sources"), headers=supabase_client.supabase_headers("return=representation"), json=source_record, timeout=30.0)
    if not source_response.is_success:
        raise HTTPException(502, "Não foi possível registrar a fonte no Supabase.")
    source_id = source_response.json()[0]["id"]
    created["source_id"] = source_id
    import_response = httpx.post(supabase_client.supabase_url("/rest/v1/imports"), headers=supabase_client.supabase_headers("return=representation"), json={"source_id": source_id, "dataset_id": dataset_id, "title": import_title, "reference_year": reference_year, "source_url": source_url, "file_name": source_name, "file_sha256": sha256(source_content).hexdigest(), "status": "needs_review", "profile": source_profile, "total_rows": sum(table.height for _, table in selected_tables)}, timeout=30.0)
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
        sheets_response = httpx.post(supabase_client.supabase_url("/rest/v1/import_sheets"), headers=supabase_client.supabase_headers(), json=sheet_records, timeout=30.0)
        if not sheets_response.is_success:
            raise HTTPException(502, "Não foi possível registrar as abas da planilha. Confirme se a migration 0008_import_sheets.sql foi executada no Supabase.")
    original_storage_path = f"imports/{import_id}/original/{source_name}"
    storage_response = httpx.post(supabase_client.supabase_url(f"/storage/v1/object/source-files/{quote(original_storage_path, safe='/')}"), headers={**supabase_client.supabase_headers("resolution=merge-duplicates"), "Content-Type": "application/octet-stream", "x-upsert": "true"}, content=source_content, timeout=180.0)
    if not storage_response.is_success:
        raise HTTPException(502, "Não foi possível guardar o arquivo original no Storage. Nada ficou gravado pela metade; tente novamente.")
    created["storage_path"] = original_storage_path
    staged_rows = [{"import_id": import_id, "sheet_name": table_name, "row_number": row_number, "raw_row": json_compatible_value(row_values)} for table_name, table in selected_tables for row_number, row_values in enumerate(table.to_dicts(), start=1)]
    for start_index in range(0, len(staged_rows), 500):
        staged_response = httpx.post(supabase_client.supabase_url("/rest/v1/import_rows"), headers=supabase_client.supabase_headers(), json=staged_rows[start_index:start_index + 500], timeout=30.0)
        if not staged_response.is_success:
            raise upstream_error("Não foi possível preparar as linhas para revisão. Nada ficou gravado pela metade; tente novamente.", staged_response)
    update_response = httpx.patch(supabase_client.supabase_url(f"/rest/v1/imports?id=eq.{import_id}"), headers=supabase_client.supabase_headers(), json={"storage_path": original_storage_path}, timeout=30.0)
    if not update_response.is_success:
        raise HTTPException(502, "O arquivo foi guardado, mas o caminho não pôde ser associado à importação.")
    return {"import_id": import_id, "status": "needs_review", "total_rows": sum(table.height for _, table in selected_tables), "imported_sheets": [table_name for table_name, _ in selected_tables], "profile": source_profile}

def upsert_staged_rows(import_id: str, sheet_name: str | None, updated_rows: list[tuple[dict[str, Any], dict[str, Any]]], failure_message: str) -> None:
    records = [{
        "import_id": import_id,
        "sheet_name": staged_row.get("sheet_name") or sheet_name or "Dados",
        "row_number": staged_row["row_number"],
        "raw_row": staged_row["raw_row"],
        "normalized_row": normalized_row,
    } for staged_row, normalized_row in updated_rows]
    for start_index in range(0, len(records), 500):
        try:
            rows_response = httpx.post(
                supabase_client.supabase_url("/rest/v1/import_rows"),
                params={"on_conflict": "import_id,sheet_name,row_number"},
                headers=supabase_client.supabase_headers("resolution=merge-duplicates,return=minimal"),
                json=records[start_index:start_index + 500],
                timeout=60.0,
            )
        except httpx.TransportError:
            raise HTTPException(502, "Perdemos a conexão com o Supabase ao preparar as linhas. Confira a importação e tente novamente.")
        if not rows_response.is_success:
            raise upstream_error(failure_message, rows_response)

def fetch_import_rows(import_id: str) -> list[dict[str, Any]]:
    import_rows: list[dict[str, Any]] = []
    page_size = 1000
    page_offset = 0
    while True:
        rows_response = httpx.get(
            supabase_client.supabase_url("/rest/v1/import_rows"),
            params={"import_id": f"eq.{import_id}", "select": "sheet_name,row_number,raw_row", "order": "sheet_name,row_number", "limit": str(page_size), "offset": str(page_offset)},
            headers=supabase_client.supabase_headers(),
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


def write_derived_sheet(import_id: str, target_sheet: str, source_sheet: str | None, rows: list[tuple[dict[str, Any], dict[str, Any]]]) -> int:
    """Grava as linhas (já preparadas) numa aba nova da mesma importação, sem tocar nas linhas originais.

    Cada linha guarda `origin_sheet` e `origin_row_number` para rastrear de onde veio. Regravar a mesma aba substitui o conteúdo.
    """
    headers = supabase_client.supabase_headers()
    delete_response = httpx.delete(supabase_client.supabase_url("/rest/v1/import_rows"), params={"import_id": f"eq.{import_id}", "sheet_name": f"eq.{target_sheet}"}, headers=headers, timeout=120.0)
    if not delete_response.is_success:
        raise upstream_error("Não foi possível limpar a aba derivada antes de gravá-la.", delete_response)
    records = []
    for position, (staged_row, normalized_row) in enumerate(rows, start=1):
        records.append({
            "import_id": import_id,
            "sheet_name": target_sheet,
            "row_number": position,
            "raw_row": staged_row["raw_row"],
            "normalized_row": {**normalized_row, "origin_sheet": source_sheet, "origin_row_number": staged_row["row_number"]},
        })
    for start_index in range(0, len(records), 500):
        try:
            rows_response = httpx.post(
                supabase_client.supabase_url("/rest/v1/import_rows"),
                params={"on_conflict": "import_id,sheet_name,row_number"},
                headers=supabase_client.supabase_headers("resolution=merge-duplicates,return=minimal"),
                json=records[start_index:start_index + 500],
                timeout=60.0,
            )
        except httpx.TransportError:
            raise HTTPException(502, "Perdemos a conexão com o Supabase ao gravar a aba derivada. Tente novamente.")
        if not rows_response.is_success:
            raise upstream_error("Não foi possível gravar as linhas da aba derivada.", rows_response)

    sheets_response = httpx.get(supabase_client.supabase_url("/rest/v1/import_sheets"), params={"import_id": f"eq.{import_id}", "select": "sheet_name,sheet_position"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    existing_sheets = sheets_response.json() if sheets_response.is_success else []
    existing_position = next((sheet["sheet_position"] for sheet in existing_sheets if sheet["sheet_name"] == target_sheet), None)
    sample_rows = [record["raw_row"] for record in records[:20]]
    sample_table = pl.from_dicts(sample_rows, infer_schema_length=20, strict=False) if sample_rows else pl.DataFrame()
    sheet_record = {
        "import_id": import_id,
        "sheet_name": target_sheet,
        "sheet_position": existing_position or max([sheet["sheet_position"] for sheet in existing_sheets] or [0]) + 1,
        "row_count": len(records),
        "column_count": sample_table.width,
        "columns_profile": [{"name": column_name, "dtype": str(sample_table[column_name].dtype), "null_count": int(sample_table[column_name].null_count())} for column_name in sample_table.columns],
        "sample_rows": sample_rows,
        "selected_for_treatment": False,
    }
    sheet_response = httpx.post(supabase_client.supabase_url("/rest/v1/import_sheets"), params={"on_conflict": "import_id,sheet_name"}, headers=supabase_client.supabase_headers("resolution=merge-duplicates,return=minimal"), json=[sheet_record], timeout=30.0)
    if not sheet_response.is_success:
        raise upstream_error("As linhas foram gravadas, mas não foi possível registrar a nova aba.", sheet_response)
    return len(records)
