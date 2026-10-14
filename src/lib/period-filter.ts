export type ReviewedFilters = {
  indicatorCode: string;
  municipalityCode: string;
  dimension: string;
  periodFrom: string;
  periodTo: string;
  search: string;
};

export const emptyReviewedFilters: ReviewedFilters = { indicatorCode: "", municipalityCode: "", dimension: "", periodFrom: "", periodTo: "", search: "" };

export const reviewedDimensions = [
  { value: "eco", label: "Economia" },
  { value: "pes", label: "Pessoas" },
  { value: "gov", label: "Governança" },
  { value: "mob", label: "Mobilidade" },
  { value: "amb", label: "Ambiente" },
  { value: "qvi", label: "Qualidade de vida" },
  { value: "idd", label: "Infraestrutura digital e dados" },
];

export function normalizePeriodInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const yearOnly = /^(\d{4})$/.exec(trimmed);
  if (yearOnly) return yearOnly[1];
  const isoMonth = /^(\d{4})-(\d{1,2})$/.exec(trimmed);
  const brazilianMonth = /^(\d{1,2})\/(\d{4})$/.exec(trimmed);
  const year = isoMonth?.[1] ?? brazilianMonth?.[2];
  const month = Number(isoMonth?.[2] ?? brazilianMonth?.[1]);
  if (!year || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function periodFilterError(periodFrom: string, periodTo: string): string {
  const from = normalizePeriodInput(periodFrom);
  const to = normalizePeriodInput(periodTo);
  if (from === null || to === null) return "Informe o período como ano (2023) ou mês (2023-05 ou 05/2023).";
  if (from && to && from > to) return "O período inicial precisa ser anterior ao período final.";
  return "";
}

export function activeFilterCount(filters: ReviewedFilters) {
  return Object.values(filters).filter((value) => value.trim()).length;
}

export function reviewedValuesQuery(filters: ReviewedFilters, limit: number, offset: number) {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (filters.indicatorCode) query.set("indicator_code", filters.indicatorCode);
  if (filters.municipalityCode) query.set("municipality_code", filters.municipalityCode);
  if (filters.dimension) query.set("dimension", filters.dimension);
  const from = normalizePeriodInput(filters.periodFrom);
  const to = normalizePeriodInput(filters.periodTo);
  if (from) query.set("period_from", from);
  if (to) query.set("period_to", to);
  if (filters.search.trim()) query.set("search", filters.search.trim());
  return query.toString();
}
