"""Filtros de linhas aplicados antes da aprovação (ex.: só o ano mais recente, só uma categoria)."""
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from pydantic import BaseModel, Field

FilterOperator = Literal["eq", "neq", "in", "gte", "lte", "contains"]


class RowFilter(BaseModel):
    field: str
    operator: FilterOperator = "eq"
    value: str = ""


class RowFilterRequest(BaseModel):
    sheet_name: str | None = None
    filters: list[RowFilter] = Field(default_factory=list, max_length=10)
    keep_latest_of: str | None = None


def cell_to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def to_decimal(value: Any) -> Decimal | None:
    text = cell_to_text(value).replace(",", ".")
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def row_matches(row: dict[str, Any], row_filter: RowFilter) -> bool:
    cell = cell_to_text(row.get(row_filter.field))
    expected = row_filter.value.strip()
    if row_filter.operator == "eq":
        return cell.casefold() == expected.casefold()
    if row_filter.operator == "neq":
        return cell.casefold() != expected.casefold()
    if row_filter.operator == "contains":
        return expected.casefold() in cell.casefold()
    if row_filter.operator == "in":
        return cell.casefold() in {part.strip().casefold() for part in expected.split(";") if part.strip()}
    left, right = to_decimal(cell), to_decimal(expected)
    if left is None or right is None:
        return False
    return left >= right if row_filter.operator == "gte" else left <= right


def latest_value_of(rows: list[dict[str, Any]], field: str) -> str | None:
    numeric = [(to_decimal(row.get(field)), cell_to_text(row.get(field))) for row in rows]
    numeric = [(number, text) for number, text in numeric if number is not None]
    if numeric:
        return max(numeric, key=lambda item: item[0])[1]
    texts = [cell_to_text(row.get(field)) for row in rows if cell_to_text(row.get(field))]
    return max(texts) if texts else None


def apply_row_filters(rows: list[dict[str, Any]], request: RowFilterRequest) -> list[dict[str, Any]]:
    """Devolve as linhas que passam em TODOS os filtros; com keep_latest_of, só as do maior valor dessa coluna."""
    kept = [row for row in rows if all(row_matches(row, row_filter) for row_filter in request.filters)]
    if request.keep_latest_of:
        latest = latest_value_of(kept, request.keep_latest_of)
        if latest is not None:
            latest_number = to_decimal(latest)
            kept = [row for row in kept if (to_decimal(row.get(request.keep_latest_of)) == latest_number if latest_number is not None else cell_to_text(row.get(request.keep_latest_of)) == latest)]
    return kept
