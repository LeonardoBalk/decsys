import re
from decimal import Decimal, InvalidOperation
from fastapi import HTTPException
from typing import Any

from .models import PeriodSelection
from .table_reading import normalize_column, normalized_sheet_title


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

def annual_period_from_column_name(column_name: str) -> int | None:
    if monthly_period_from_column_name(column_name):
        return None
    year_match = re.search(r"(?:^|_)((?:19|20)[0-9]{2})(?:_|$)", normalized_sheet_title(normalize_column(column_name)))
    return int(year_match.group(1)) if year_match else None

def monthly_period_from_column_name(column_name: str) -> tuple[int, int] | None:
    normalized_name = normalized_sheet_title(normalize_column(column_name))
    period_match = re.search(r"(?:^|_)(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)_((?:19|20)[0-9]{2})(?:_|$)", normalized_name)
    return (int(period_match.group(2)), month_numbers_by_name[period_match.group(1)]) if period_match else None

identity_column_names = {"uf", "sigla_uf", "estado", "municipio", "nome_municipio", "nome_do_municipio", "cidade"}

def period_column_descriptor(column_name: str) -> dict[str, Any] | None:
    monthly_period = monthly_period_from_column_name(column_name)
    if monthly_period:
        return {"field": column_name, "year": monthly_period[0], "month": monthly_period[1]}
    annual_year = annual_period_from_column_name(column_name)
    return {"field": column_name, "year": annual_year, "month": None} if annual_year else None
