from pydantic import BaseModel, Field, HttpUrl
from typing import Annotated, Any, Literal


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
    numerator_field: str | None = None
    denominator_field: str | None = None
    unit: str
    sheet_name: str | None = None
    period: PeriodSelection | None = None

class MunicipalIndicatorMapping(BaseModel):
    indicator_id: str
    value_field: str | None = None
    numerator_field: str | None = None
    denominator_field: str | None = None
    denominator_source: Literal["column", "population"] = "column"
    value_min: float | None = None
    value_max: float | None = None
    unit: str

class MunicipalBatchApproval(BaseModel):
    mappings: list[MunicipalIndicatorMapping] = Field(min_length=1, max_length=20)
    municipality_field: str
    sheet_name: str | None = None
    period: PeriodSelection

class MunicipalCalculationPreview(BaseModel):
    calculation_type: Literal["direct", "ratio"]
    direct_field: str = ""
    numerator_field: str = ""
    denominator_field: str = ""
    calculation_multiplier: float = 1
    sheet_name: str | None = None

class IiuWeightsUpdate(BaseModel):
    city_profile: Literal["pequeno", "medio", "grande", "metropole"]
    weights: dict[str, float]

class IiuBenchmarkUpdate(BaseModel):
    indicator_code: str
    city_profile: Literal["pequeno", "medio", "grande", "metropole"]
    minimum_value: float
    maximum_value: float

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
    calculation_type: Literal["direct", "ratio"] = "direct"
    calculation_multiplier: float = 1
    iiu_enabled: bool = False
    iiu_dimension_code: str | None = None
    score_direction: Literal["direct", "inverse", "checklist"] | None = None
    checklist_max: float | None = None

class IndicatorUpdate(BaseModel):
    name: str
    dimension: str
    definition: str
    unit: str
    expected_frequency: str | None = None
    calculation_type: Literal["direct", "ratio"] = "direct"
    calculation_multiplier: float = 1
    iiu_enabled: bool = False
    iiu_dimension_code: str | None = None
    score_direction: Literal["direct", "inverse", "checklist"] | None = None
    checklist_max: float | None = None

class CollectionSourceInput(BaseModel):
    dimension: str = ""
    factor: str = ""
    name: str = ""
    definition: str = ""
    unit: str = ""
    source: str = ""
    official_link: Annotated[str | None, Field(alias="officialLink")] = None
    access: Literal["link", "manual", "local"] = "manual"
    import_url: Annotated[str | None, Field(alias="importUrl")] = None
    manual_url: Annotated[str | None, Field(alias="manualUrl")] = None
    steps: str = ""
    needs: list[str] = Field(default_factory=list)
    notes: str | None = None

    model_config = {"populate_by_name": True}

class PeriodExpansion(BaseModel):
    sheet_name: str | None = None
    municipality_field: str
    measure_label: str
    period_fields: list[str] = Field(min_length=1)
