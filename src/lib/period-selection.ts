import { normalizedColumnName } from "@/lib/municipal-columns";
import { SourceProfile } from "@/lib/types/importacao";

export type PeriodMode = "year_column" | "date_column" | "month_year_columns" | "fixed" | "prepared";
export type PeriodGranularity = "year" | "month";

export type PeriodSelection = {
  mode: PeriodMode;
  granularity: PeriodGranularity;
  yearField: string;
  monthField: string;
  dateField: string;
  fixedYear: string;
  fixedMonth: string;
};

export const periodModeLabels: Record<PeriodMode, string> = {
  year_column: "Uma coluna com o ano",
  date_column: "Uma coluna com data ou mês/ano (ex.: 2024-03-01, 03/2024, jan/2024, 202403)",
  month_year_columns: "Uma coluna com o mês e outra com o ano",
  fixed: "Não está na planilha — informar o período",
  prepared: "Período preparado a partir das colunas da planilha",
};

export const monthNames = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function findColumn(sourceProfile: SourceProfile, pattern: RegExp) {
  return sourceProfile.columns.find((column) => pattern.test(normalizedColumnName(column.name)))?.name ?? "";
}

export function suggestedPeriod(sourceProfile: SourceProfile): PeriodSelection {
  const emptySelection: PeriodSelection = { mode: "fixed", granularity: "year", yearField: "", monthField: "", dateField: "", fixedYear: "", fixedMonth: "" };
  const yearField = sourceProfile.columns.some((column) => column.name === sourceProfile.suggestions.reference_year) ? sourceProfile.suggestions.reference_year : findColumn(sourceProfile, /(?:^|_)(?:ano|year|exercicio)(?:_|$)/);
  const monthField = findColumn(sourceProfile, /(?:^|_)(?:mes|month)(?:_|$)/);
  const dateField = findColumn(sourceProfile, /(?:^|_)(?:data|date|competencia|periodo|referencia|mes_ano|ano_mes)(?:_|$)/);
  if (yearField && monthField) return { ...emptySelection, mode: "month_year_columns", granularity: "month", yearField, monthField };
  if (yearField) return { ...emptySelection, mode: "year_column", yearField };
  if (dateField) return { ...emptySelection, mode: "date_column", granularity: "month", dateField };
  return emptySelection;
}

export function effectiveGranularity(selection: PeriodSelection, preparedGranularity: PeriodGranularity | null): PeriodGranularity {
  if (selection.mode === "year_column") return "year";
  if (selection.mode === "month_year_columns") return "month";
  if (selection.mode === "prepared") return preparedGranularity ?? "year";
  return selection.granularity;
}

export function frequencyGranularity(expectedFrequency: string | null | undefined): PeriodGranularity | null {
  const frequency = normalizedColumnName(expectedFrequency ?? "");
  if (frequency.includes("mens")) return "month";
  if (frequency.includes("anu")) return "year";
  return null;
}

export function isPeriodSelectionComplete(selection: PeriodSelection) {
  if (selection.mode === "year_column") return Boolean(selection.yearField);
  if (selection.mode === "date_column") return Boolean(selection.dateField);
  if (selection.mode === "month_year_columns") return Boolean(selection.yearField && selection.monthField);
  if (selection.mode === "fixed") {
    const year = Number(selection.fixedYear);
    const hasYear = Number.isInteger(year) && year >= 1900 && year <= 2200;
    return hasYear && (selection.granularity === "year" || Boolean(selection.fixedMonth));
  }
  return true;
}

export function periodRequest(selection: PeriodSelection) {
  return {
    mode: selection.mode,
    granularity: selection.granularity,
    year_field: selection.yearField || null,
    month_field: selection.monthField || null,
    date_field: selection.dateField || null,
    fixed_year: selection.fixedYear ? Number(selection.fixedYear) : null,
    fixed_month: selection.fixedMonth ? Number(selection.fixedMonth) : null,
  };
}
