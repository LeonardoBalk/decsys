import httpx
import polars as pl
import re
from decimal import Decimal, InvalidOperation
from fastapi import HTTPException, Response
from typing import Any
from fastapi import APIRouter

from . import config, import_store, jobs, municipalities, population, routes_indicators, supabase_client
from .models import GenericApproval, MunicipalApproval, MunicipalBatchApproval, MunicipalCalculationPreview, PeriodExpansion, PeriodSelection, WideMunicipalTransform
from .municipalities import municipality_code_resolver
from .periods import annual_period_from_column_name, cell_text, identity_column_names, monthly_period_from_column_name, parse_date_period, parse_numeric_value, parse_year, period_column_descriptor, resolve_row_period, valid_period, validate_period_selection
from .routes_indicators import indicator_fields
from .supabase_client import indicator_registry_path, registry_error, upstream_error
from .table_reading import is_municipality_code_column, period_from_column_name

router = APIRouter()


@router.post("/imports/{import_id}/approve-municipal")
def approve_municipal_import(import_id: str, approval: MunicipalApproval) -> dict[str, Any]:
    period = approval.period or (PeriodSelection(mode="year_column", year_field=approval.year_field) if approval.year_field else None)
    if not period:
        raise HTTPException(422, "Informe como o período aparece na planilha.")
    validate_period_selection(period)
    selected_indicator = routes_indicators.get_indicator(approval.indicator_id)
    calculation_type = selected_indicator.get("calculation_type") or "direct"
    calculation_value_field = approval.value_field
    if calculation_type == "ratio":
        if not approval.numerator_field or not approval.denominator_field or approval.numerator_field == approval.denominator_field:
            raise HTTPException(422, "Escolha as colunas usadas no cálculo deste indicador.")
        calculation_response = httpx.post(supabase_client.supabase_url("/rest/v1/rpc/prepare_municipal_import_calculation"), headers=supabase_client.supabase_headers(), json={"selected_import_id": import_id, "selected_sheet_name": approval.sheet_name, "numerator_field": approval.numerator_field, "denominator_field": approval.denominator_field, "calculation_multiplier": float(selected_indicator.get("calculation_multiplier") or 1)}, timeout=300.0)
        if not calculation_response.is_success:
            raise HTTPException(503, "Execute a migration 0018_indicator_and_iiu_configuration.sql no Supabase para aplicar fórmulas de indicadores.")
        calculation_value_field = "value"
    municipalities.ensure_municipal_catalog_registered()
    is_already_prepared = period.mode == "prepared" and calculation_value_field == "value" and approval.municipality_field == "municipality_ibge_code"
    period_problems: list[dict[str, Any]] = []
    value_problems: list[dict[str, Any]] = []
    municipality_problems: list[dict[str, Any]] = []
    rpc_municipality_field = "municipality_ibge_code"
    if not is_already_prepared:
        staged_rows = municipalities.fetch_rows_for_municipality_resolution(import_id, approval.sheet_name)
        resolve_municipality = municipality_code_resolver(municipalities.ibge_municipality_catalog())
        prepared_rows, period_problems, value_problems, municipality_problems = prepare_rows_for_approval(staged_rows, period, calculation_value_field, approval.municipality_field, resolve_municipality)
        import_store.upsert_staged_rows(import_id, approval.sheet_name, prepared_rows, "Não foi possível preparar município, período e valor das linhas antes da gravação.")
        rpc_municipality_field = approval_municipality_field
    approval_response = httpx.post(supabase_client.supabase_url("/rest/v1/rpc/approve_municipal_import"), headers=supabase_client.supabase_headers(), json={"selected_import_id": import_id, "selected_indicator_id": approval.indicator_id, "municipality_field": rpc_municipality_field, "year_field": "reference_year", "value_field": "value", "observation_unit": approval.unit, "selected_sheet_name": approval.sheet_name}, timeout=300.0)
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

@router.post("/imports/{import_id}/approve-municipal-batch")
def approve_municipal_import_batch(import_id: str, approval: MunicipalBatchApproval, response: Response, background: bool = False) -> dict[str, Any]:
    """Grava várias medidas da mesma aba. Com background=true devolve 202 e uma tarefa para acompanhar em GET /jobs/{id}."""
    if background:
        validate_period_selection(approval.period)
        job = jobs.start_job("approve", import_id, lambda running_job: run_batch_approval(import_id, approval, running_job.report))
        response.status_code = 202
        return job.public()
    return run_batch_approval(import_id, approval)


def clamp_value_text(value_text: str | None, value_min: float | None, value_max: float | None) -> str | None:
    if value_text is None or (value_min is None and value_max is None):
        return value_text
    try:
        number = Decimal(value_text)
    except InvalidOperation:
        return value_text
    if value_max is not None and number > Decimal(str(value_max)):
        number = Decimal(str(value_max))
    if value_min is not None and number < Decimal(str(value_min)):
        number = Decimal(str(value_min))
    text = format(number, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def chunk_sheet_name(sheet_name: str | None, index: int, total: int) -> str:
    return f"{sheet_name or 'Dados'} · parte {index} de {total}"


class CachedPopulationLookup:
    """Busca a população de cada ano uma vez; anos que o IBGE não publica viram 'sem população' em vez de derrubar tudo."""

    def __init__(self) -> None:
        self.by_year: dict[int, dict[str, int]] = {}
        self.missing_years: set[int] = set()

    def __call__(self, year: int) -> dict[str, int]:
        if year in self.by_year:
            return self.by_year[year]
        try:
            self.by_year[year] = population.population_by_municipality(year)
        except HTTPException as unavailable:
            if unavailable.status_code != 422:
                raise
            self.by_year[year] = {}
            self.missing_years.add(year)
        return self.by_year[year]


def run_batch_approval(import_id: str, approval: MunicipalBatchApproval, progress: Any = None) -> dict[str, Any]:
    report = progress or (lambda phase, fraction=None: None)
    validate_period_selection(approval.period)
    report("Conferindo os indicadores escolhidos", 0.02)
    indicator_ids = [mapping.indicator_id for mapping in approval.mappings]
    if len(set(indicator_ids)) != len(indicator_ids):
        raise HTTPException(422, "Escolha cada indicador uma unica vez nesta importacao.")
    indicator_response = httpx.get(
        supabase_client.supabase_url(indicator_registry_path),
        params={"select": indicator_fields, "id": f"in.({','.join(indicator_ids)})", "active": "is.true"},
        headers=supabase_client.supabase_headers(),
        timeout=30.0,
    )
    if not indicator_response.is_success:
        raise registry_error("Nao foi possivel carregar os indicadores selecionados.", indicator_response)
    indicators_by_id = {indicator["id"]: indicator for indicator in indicator_response.json()}
    if set(indicators_by_id) != set(indicator_ids):
        raise HTTPException(422, "Um ou mais indicadores nao existem ou foram desativados. Atualize o catalogo e tente novamente.")

    selected_mappings: list[dict[str, Any]] = []
    for mapping in approval.mappings:
        selected_indicator = indicators_by_id[mapping.indicator_id]
        calculation_type = selected_indicator.get("calculation_type") or "direct"
        if not mapping.unit.strip():
            raise HTTPException(422, f"Informe a unidade do indicador {selected_indicator['name']}.")
        if mapping.value_min is not None and mapping.value_max is not None and mapping.value_min >= mapping.value_max:
            raise HTTPException(422, f"Em {selected_indicator['name']}, o limite mínimo precisa ser menor que o máximo.")
        if calculation_type == "ratio":
            if mapping.denominator_source == "population":
                if not mapping.numerator_field:
                    raise HTTPException(422, f"Escolha a coluna do numerador para {selected_indicator['name']}.")
            elif not mapping.numerator_field or not mapping.denominator_field or mapping.numerator_field == mapping.denominator_field:
                raise HTTPException(422, f"Escolha numerador e denominador diferentes para {selected_indicator['name']}.")
        elif not mapping.value_field:
            raise HTTPException(422, f"Escolha a coluna de valor para {selected_indicator['name']}.")
        selected_mappings.append({
            "indicator_id": mapping.indicator_id,
            "indicator_code": selected_indicator["code"],
            "indicator_name": selected_indicator["name"],
            "calculation_type": calculation_type,
            "calculation_multiplier": float(selected_indicator.get("calculation_multiplier") or 1),
            "value_field": mapping.value_field,
            "numerator_field": mapping.numerator_field,
            "denominator_field": mapping.denominator_field,
            "denominator_source": mapping.denominator_source if calculation_type == "ratio" else "column",
            "value_min": mapping.value_min,
            "value_max": mapping.value_max,
            "unit": mapping.unit.strip(),
            "prepared_field": f"decsys_value__{selected_indicator['code']}",
        })

    municipalities.ensure_municipal_catalog_registered()
    report("Lendo as linhas da importação", 0.08)
    staged_rows = municipalities.fetch_rows_for_municipality_resolution(import_id, approval.sheet_name)
    resolve_municipality = municipality_code_resolver(municipalities.ibge_municipality_catalog())
    report("Resolvendo municípios, períodos e valores", 0.25)
    population_for_year = CachedPopulationLookup() if any(mapping["denominator_source"] == "population" for mapping in selected_mappings) else None
    prepared_rows, preparation_summary = prepare_rows_for_batch_approval(staged_rows, approval.period, selected_mappings, approval.municipality_field, resolve_municipality, population_for_year)
    missing_population_years = sorted(population_for_year.missing_years) if population_for_year else []

    chunk_size = max(500, config.approval_chunk_rows)
    approved_by_indicator: dict[str, int] = {}
    final_status = "needs_review"
    approved_total = 0
    chunk_count = 1
    rpc_mappings = [{"indicator_id": mapping["indicator_id"], "indicator_code": mapping["indicator_code"], "prepared_field": mapping["prepared_field"], "observation_unit": mapping["unit"]} for mapping in selected_mappings]

    def approve_sheet(target_sheet: str | None) -> dict[str, Any]:
        batch_response = httpx.post(
            supabase_client.supabase_url("/rest/v1/rpc/approve_municipal_import_batch"),
            headers=supabase_client.supabase_headers(),
            json={"selected_import_id": import_id, "selected_mappings": rpc_mappings, "selected_sheet_name": target_sheet},
            timeout=900.0,
        )
        if batch_response.status_code == 404:
            raise HTTPException(503, "Execute a migration 0019_batch_municipal_approval.sql no Supabase para gravar varios indicadores de uma vez.")
        if not batch_response.is_success:
            raise upstream_error("Nao foi possivel aprovar os indicadores selecionados.", batch_response)
        return batch_response.json()

    if len(prepared_rows) <= chunk_size:
        report("Guardando os valores preparados", 0.5)
        import_store.upsert_staged_rows(import_id, approval.sheet_name, prepared_rows, "Nao foi possivel preparar os valores selecionados antes da aprovacao.")
        report("Gravando no painel municipal", 0.7)
        publication_summary = approve_sheet(approval.sheet_name)
        approved_by_indicator = {item["indicator_id"]: item["approved_rows"] for item in publication_summary.get("indicators", [])}
        final_status = publication_summary.get("status", "needs_review")
        approved_total = publication_summary.get("approved_value_count", 0)
    else:
        chunks = [prepared_rows[start_index:start_index + chunk_size] for start_index in range(0, len(prepared_rows), chunk_size)]
        chunk_count = len(chunks)
        source_sheet = approval.sheet_name or "Dados"
        for index, chunk in enumerate(chunks, start=1):
            target_sheet = chunk_sheet_name(source_sheet, index, chunk_count)
            report(f"Gravando parte {index} de {chunk_count}", 0.3 + 0.65 * ((index - 1) / chunk_count))
            import_store.write_derived_sheet(import_id, target_sheet, source_sheet, chunk)
            publication_summary = approve_sheet(target_sheet)
            for item in publication_summary.get("indicators", []):
                approved_by_indicator[item["indicator_id"]] = approved_by_indicator.get(item["indicator_id"], 0) + item["approved_rows"]
            approved_total += publication_summary.get("approved_value_count", 0)
            if publication_summary.get("status") == "approved":
                final_status = "approved"

    report("Montando o resumo", 0.97)
    indicator_results = []
    for mapping in selected_mappings:
        indicator_id = mapping["indicator_id"]
        indicator_results.append({"indicator_id": indicator_id, "indicator_code": mapping["indicator_code"], "indicator_name": mapping["indicator_name"], "approved_rows": approved_by_indicator.get(indicator_id, 0), **preparation_summary["indicator_problems"][indicator_id]})
    return {"import_id": import_id, "status": final_status, "approved_value_count": approved_total, "chunks": chunk_count, "missing_population_years": missing_population_years, "period_problem_count": len(preparation_summary["period_problems"]), "period_problems": preparation_summary["period_problems"][:5], "municipality_problem_count": len(preparation_summary["municipality_problems"]), "municipality_problems": preparation_summary["municipality_problems"][:5], "indicator_results": indicator_results}


@router.post("/imports/{import_id}/municipal-preview")
def preview_municipal_import_calculation(import_id: str, preview: MunicipalCalculationPreview) -> dict[str, Any]:
    if preview.calculation_type == "ratio" and not 0 < preview.calculation_multiplier <= 1000000:
        raise HTTPException(422, "O multiplicador precisa ser maior que zero e menor ou igual a 1.000.000.")
    if preview.calculation_type == "direct" and not preview.direct_field:
        raise HTTPException(422, "Escolha a coluna que contém o valor do indicador.")
    if preview.calculation_type == "ratio" and (not preview.numerator_field or not preview.denominator_field or preview.numerator_field == preview.denominator_field):
        raise HTTPException(422, "Escolha as colunas do numerador e denominador.")
    preview_response = httpx.post(supabase_client.supabase_url("/rest/v1/rpc/preview_municipal_import_calculation"), headers=supabase_client.supabase_headers(), json={"selected_import_id": import_id, "selected_sheet_name": preview.sheet_name, "calculation_type": preview.calculation_type, "direct_field": preview.direct_field, "numerator_field": preview.numerator_field, "denominator_field": preview.denominator_field, "calculation_multiplier": preview.calculation_multiplier}, timeout=90.0)
    if not preview_response.is_success:
        if preview_response.status_code == 404:
            raise HTTPException(503, "Execute a migration 0018_indicator_and_iiu_configuration.sql no Supabase para pré-visualizar fórmulas.")
        raise upstream_error("Não foi possível calcular uma prévia deste indicador.", preview_response)
    return preview_response.json()

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

def prepare_rows_for_batch_approval(staged_rows: list[dict[str, Any]], period: PeriodSelection, mappings: list[dict[str, Any]], municipality_field: str, resolve_municipality: Any, population_for_year: Any = None) -> tuple[list[tuple[dict[str, Any], dict[str, Any]]], dict[str, Any]]:
    prepared_rows: list[tuple[dict[str, Any], dict[str, Any]]] = []
    period_problems: list[dict[str, Any]] = []
    municipality_problems: list[dict[str, Any]] = []
    indicator_problems = {mapping["indicator_id"]: {"value_problem_count": 0, "value_problems": []} for mapping in mappings}

    for staged_row in staged_rows:
        normalized_row = dict(staged_row.get("normalized_row") or {})
        source_row = {**(staged_row.get("raw_row") or {}), **normalized_row}
        resolved_code = resolve_municipality(source_row.get(municipality_field))
        normalized_row[approval_municipality_field] = resolved_code
        if not resolved_code:
            municipality_problems.append({"row_number": staged_row["row_number"], "value": cell_text(source_row.get(municipality_field))})

        if period.mode == "prepared":
            selected_period = parse_date_period(source_row.get("reference_period")) if source_row.get("reference_period") else None
            selected_year = parse_year(source_row.get("reference_year"))
            if selected_period:
                selected_year = selected_period[0]
                if period.granularity == "year":
                    selected_period = (selected_year, None)
                elif selected_period[1] is None:
                    selected_period = None
            elif selected_year and period.granularity == "year":
                selected_period = (selected_year, None)
            if selected_period and valid_period(*selected_period):
                normalized_row["reference_year"] = str(selected_period[0])
                if selected_period[1]:
                    normalized_row["reference_period"] = f"{selected_period[0]}-{selected_period[1]:02d}-01"
                else:
                    normalized_row.pop("reference_period", None)
            else:
                period_problems.append({"row_number": staged_row["row_number"], "value": cell_text(source_row.get("reference_period") or source_row.get("reference_year"))})
        else:
            normalized_row.pop("reference_year", None)
            normalized_row.pop("reference_period", None)
            selected_period, original_period = resolve_row_period(source_row, period)
            if selected_period:
                normalized_row["reference_year"] = str(selected_period[0])
                if selected_period[1]:
                    normalized_row["reference_period"] = f"{selected_period[0]}-{selected_period[1]:02d}-01"
            else:
                period_problems.append({"row_number": staged_row["row_number"], "value": original_period})

        indicator_values = dict(normalized_row.get("indicator_values") or {})
        indicator_calculations = dict(normalized_row.get("indicator_calculations") or {})
        for mapping in mappings:
            selected_indicator_id = mapping["indicator_id"]
            if mapping["calculation_type"] == "ratio" and mapping.get("denominator_source") == "population":
                numerator_text = parse_numeric_value(source_row.get(mapping["numerator_field"]))
                reference_year = parse_year(normalized_row.get("reference_year"))
                inhabitants = population_for_year(reference_year).get(resolved_code or "") if population_for_year and reference_year else None
                try:
                    calculated_value = Decimal(numerator_text) / Decimal(inhabitants) * Decimal(str(mapping["calculation_multiplier"])) if numerator_text is not None and inhabitants else None
                except (InvalidOperation, ZeroDivisionError):
                    calculated_value = None
                value_text = format(calculated_value, "f") if calculated_value is not None else None
                if value_text and "." in value_text:
                    value_text = value_text.rstrip("0").rstrip(".")
                calculation = {"type": "ratio_population", "numerator_field": mapping["numerator_field"], "population_year": reference_year, "multiplier": mapping["calculation_multiplier"]}
                source_measure = f"{cell_text(source_row.get(mapping['numerator_field']))} / população {reference_year or '?'}: {inhabitants if inhabitants else 'sem dado'}"
            elif mapping["calculation_type"] == "ratio":
                numerator_text = parse_numeric_value(source_row.get(mapping["numerator_field"]))
                denominator_text = parse_numeric_value(source_row.get(mapping["denominator_field"]))
                try:
                    denominator = Decimal(denominator_text) if denominator_text is not None else Decimal(0)
                    calculated_value = Decimal(numerator_text) / denominator * Decimal(str(mapping["calculation_multiplier"])) if numerator_text is not None and denominator != 0 else None
                except (InvalidOperation, ZeroDivisionError):
                    calculated_value = None
                value_text = format(calculated_value, "f") if calculated_value is not None else None
                if value_text and "." in value_text:
                    value_text = value_text.rstrip("0").rstrip(".")
                calculation = {"type": "ratio", "numerator_field": mapping["numerator_field"], "denominator_field": mapping["denominator_field"], "multiplier": mapping["calculation_multiplier"]}
                source_measure = f"{cell_text(source_row.get(mapping['numerator_field']))} / {cell_text(source_row.get(mapping['denominator_field']))}"
            else:
                value_text = parse_numeric_value(source_row.get(mapping["value_field"]))
                calculation = {"type": "direct", "value_field": mapping["value_field"]}
                source_measure = cell_text(source_row.get(mapping["value_field"]))

            value_text = clamp_value_text(value_text, mapping.get("value_min"), mapping.get("value_max"))
            normalized_row[mapping["prepared_field"]] = value_text
            indicator_values[mapping["indicator_code"]] = value_text
            indicator_calculations[mapping["indicator_code"]] = calculation
            if value_text is None:
                indicator_problems[selected_indicator_id]["value_problem_count"] += 1
                if len(indicator_problems[selected_indicator_id]["value_problems"]) < 5:
                    indicator_problems[selected_indicator_id]["value_problems"].append({"row_number": staged_row["row_number"], "value": source_measure})

        normalized_row["indicator_values"] = indicator_values
        normalized_row["indicator_calculations"] = indicator_calculations
        prepared_rows.append((staged_row, normalized_row))

    return prepared_rows, {"period_problems": period_problems, "municipality_problems": municipality_problems, "indicator_problems": indicator_problems}

@router.post("/imports/{import_id}/normalize-wide")
def normalize_wide_period_import(import_id: str, transformation: WideMunicipalTransform) -> dict[str, Any]:
    monthly_period = monthly_period_from_column_name(transformation.value_field)
    annual_year = None if monthly_period else annual_period_from_column_name(transformation.value_field)
    if not monthly_period and not annual_year:
        raise HTTPException(422, "O título da coluna escolhida não informa um período. Escolha uma coluna como julho_2026 ou valor_2021.")
    reference_year = monthly_period[0] if monthly_period else annual_year
    reference_month = monthly_period[1] if monthly_period else None
    staged_rows = municipalities.fetch_rows_for_municipality_resolution(import_id, transformation.sheet_name)
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
    import_store.upsert_staged_rows(import_id, transformation.sheet_name, updated_rows, "Não foi possível guardar a versão normalizada das linhas.")
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

@router.post("/imports/{import_id}/expand-periods")
def expand_import_periods(import_id: str, expansion: PeriodExpansion) -> dict[str, Any]:
    period_columns = [descriptor for descriptor in (period_column_descriptor(field_name) for field_name in expansion.period_fields) if descriptor]
    if len(period_columns) != len(expansion.period_fields):
        raise HTTPException(422, "Uma das colunas escolhidas não informa mês e ano ou ano no título.")
    source_sheet = expansion.sheet_name or "Dados"
    measure_label = re.sub(r"\s+", " ", expansion.measure_label).strip()[:60] or "medida"
    target_sheet = f"{source_sheet} · {measure_label} por período"
    municipalities.ensure_municipal_catalog_registered()
    sheets_response = httpx.get(supabase_client.supabase_url("/rest/v1/import_sheets"), params={"import_id": f"eq.{import_id}", "select": "sheet_name,sheet_position,columns_profile"}, headers=supabase_client.supabase_headers(), timeout=30.0)
    if not sheets_response.is_success:
        raise upstream_error("Não foi possível ler as abas desta importação.", sheets_response)
    sheet_records = sheets_response.json()
    if not any(record["sheet_name"] == source_sheet for record in sheet_records):
        import_response = httpx.get(supabase_client.supabase_url("/rest/v1/imports"), params={"id": f"eq.{import_id}", "select": "profile,total_rows"}, headers=supabase_client.supabase_headers(), timeout=30.0)
        import_record = (import_response.json() or [{}])[0] if import_response.is_success else {}
        import_profile = import_record.get("profile") or {}
        source_record = {"import_id": import_id, "sheet_name": source_sheet, "sheet_position": 1, "row_count": int(import_record.get("total_rows") or 0), "column_count": len(import_profile.get("columns") or []), "columns_profile": import_profile.get("columns") or [], "sample_rows": import_profile.get("sample") or [], "selected_for_treatment": True}
        source_sheet_response = httpx.post(supabase_client.supabase_url("/rest/v1/import_sheets"), params={"on_conflict": "import_id,sheet_name"}, headers=supabase_client.supabase_headers("resolution=merge-duplicates,return=minimal"), json=[source_record], timeout=30.0)
        if not source_sheet_response.is_success:
            raise upstream_error("Não foi possível registrar a aba de origem desta importação.", source_sheet_response)
        sheet_records.append({"sheet_name": source_sheet, "sheet_position": 1, "columns_profile": source_record["columns_profile"]})
    source_columns = next((record.get("columns_profile") or [] for record in sheet_records if record["sheet_name"] == source_sheet), [])
    identity_fields = list(dict.fromkeys([expansion.municipality_field, *[column["name"] for column in source_columns if column.get("name") in identity_column_names or is_municipality_code_column(str(column.get("name", "")))]]))
    expansion_response = httpx.post(supabase_client.supabase_url("/rest/v1/rpc/expand_import_periods"), headers=supabase_client.supabase_headers(), json={"selected_import_id": import_id, "source_sheet_name": source_sheet, "target_sheet_name": target_sheet, "selected_municipality_field": expansion.municipality_field, "identity_fields": identity_fields, "period_columns": period_columns}, timeout=300.0)
    if expansion_response.status_code == 404:
        raise HTTPException(503, "Execute a migration 0016_expand_import_periods.sql no Supabase para transformar todos os períodos de uma vez.")
    if not expansion_response.is_success:
        raise upstream_error("Não foi possível criar a aba com os períodos.", expansion_response)
    outcome = expansion_response.json()[0]
    sample_response = httpx.get(supabase_client.supabase_url("/rest/v1/import_rows"), params={"import_id": f"eq.{import_id}", "sheet_name": f"eq.{target_sheet}", "select": "raw_row", "order": "row_number.asc", "limit": "20"}, headers=supabase_client.supabase_headers(), timeout=30.0)
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
    sheet_response = httpx.post(supabase_client.supabase_url("/rest/v1/import_sheets"), params={"on_conflict": "import_id,sheet_name"}, headers=supabase_client.supabase_headers("resolution=merge-duplicates,return=minimal"), json=[sheet_record], timeout=30.0)
    if not sheet_response.is_success:
        raise upstream_error("As linhas foram criadas, mas não foi possível registrar a nova aba.", sheet_response)
    return {"import_id": import_id, "sheet_name": target_sheet, "periods": len(period_columns), "granularity": "month" if any(column["month"] for column in period_columns) else "year", **outcome}

@router.post("/imports/{import_id}/normalize-municipal-wide")
def normalize_municipal_wide_import(import_id: str, transformation: WideMunicipalTransform) -> dict[str, Any]:
    period = period_from_column_name(transformation.value_field)
    if not period:
        raise HTTPException(422, "A coluna escolhida não informa um mês e ano no título. Escolha uma coluna como julho_2026_saldos.")
    reference_year, reference_month = period
    transformation_response = httpx.post(supabase_client.supabase_url("/rest/v1/rpc/normalize_municipal_wide_import"), headers=supabase_client.supabase_headers(), json={"selected_import_id": import_id, "selected_municipality_field": transformation.municipality_field, "selected_value_field": transformation.value_field, "selected_reference_year": reference_year, "selected_reference_month": reference_month, "selected_sheet_name": transformation.sheet_name}, timeout=60.0)
    if not transformation_response.is_success:
        raise upstream_error("Não foi possível guardar a versão normalizada das linhas.", transformation_response)
    outcome = transformation_response.json()[0]
    return {"import_id": import_id, "municipality_field": "municipality_ibge_code", "year_field": "reference_year", "value_field": "value", "reference_period": f"{reference_year}-{reference_month:02d}-01", **outcome}

@router.post("/imports/{import_id}/approve")
def approve_generic_import(import_id: str, approval: GenericApproval) -> dict[str, str]:
    approval_response = httpx.post(supabase_client.supabase_url("/rest/v1/rpc/approve_generic_import"), headers=supabase_client.supabase_headers(), json={"selected_import_id": import_id, "selected_mapping": approval.mapping, "selected_explanation": approval.explanation}, timeout=30.0)
    if not approval_response.is_success:
        raise upstream_error("Não foi possível registrar a aprovação da importação.", approval_response)
    return {"import_id": import_id, "status": "approved", "proposal_id": approval_response.json()}
