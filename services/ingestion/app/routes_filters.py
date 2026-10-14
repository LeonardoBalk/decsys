from typing import Any

from fastapi import APIRouter, HTTPException, Response

from . import import_store, jobs, municipalities
from .row_filters import RowFilterRequest, apply_row_filters

router = APIRouter()


def run_row_filter(import_id: str, request: RowFilterRequest, progress: Any = None) -> dict[str, Any]:
    report = progress or (lambda phase, fraction=None: None)
    if not request.filters and not request.keep_latest_of:
        raise HTTPException(422, "Escolha ao menos um filtro ou a coluna do período mais recente.")
    report("Lendo as linhas", 0.1)
    staged_rows = municipalities.fetch_rows_for_municipality_resolution(import_id, request.sheet_name)
    report("Aplicando os filtros", 0.5)
    merged_rows = [{**(staged.get("raw_row") or {}), **(staged.get("normalized_row") or {})} for staged in staged_rows]
    kept_rows = apply_row_filters(merged_rows, request)
    if not kept_rows:
        raise HTTPException(422, "Nenhuma linha passou nos filtros. Confira a coluna, o operador e o valor.")
    kept_ids = {id(row) for row in kept_rows}
    kept_staged = [staged for staged, merged in zip(staged_rows, merged_rows) if id(merged) in kept_ids]
    source_sheet = request.sheet_name or "Dados"
    target_sheet = f"{source_sheet} · filtrada"
    report("Gravando a aba filtrada", 0.7)
    written = import_store.write_derived_sheet(import_id, target_sheet, source_sheet, [(staged, dict(staged.get("normalized_row") or {})) for staged in kept_staged])
    return {"import_id": import_id, "sheet_name": target_sheet, "source_sheet": source_sheet, "total_rows": len(staged_rows), "kept_rows": written, "removed_rows": len(staged_rows) - written}


@router.post("/imports/{import_id}/filter-rows")
def filter_import_rows(import_id: str, request: RowFilterRequest, response: Response, background: bool = False) -> dict[str, Any]:
    """Cria uma aba nova só com as linhas que passam nos filtros. A aba original não é alterada."""
    if background:
        job = jobs.start_job("filter", import_id, lambda running_job: run_row_filter(import_id, request, running_job.report))
        response.status_code = 202
        return job.public()
    return run_row_filter(import_id, request)
