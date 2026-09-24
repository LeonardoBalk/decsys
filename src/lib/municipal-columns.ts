import { SourceProfile } from "@/lib/types/importacao";

type SourceColumn = SourceProfile["columns"][number];

export function normalizedColumnName(columnName: string) {
  return columnName.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function isPeriodColumn(columnName: string) {
  return /(?:^|_)(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)_(?:19|20)\d{2}(?:_|$)/.test(normalizedColumnName(columnName));
}

export function isAnnualPeriodColumn(columnName: string) {
  return !isPeriodColumn(columnName) && /(?:^|_)(?:19|20)\d{2}(?:_|$)/.test(normalizedColumnName(columnName));
}

export function isMunicipalityColumn(columnName: string) {
  return /(?:^|_)(?:municipio|municipios|municipality|ibge|cod_mun|codigo_municipal|cidade|cidades|localidade|nome_municipio)(?:_|$)/.test(normalizedColumnName(columnName));
}

export function hasSourceColumn(sourceProfile: SourceProfile, columnName: string | undefined) {
  return Boolean(columnName && sourceProfile.columns.some((column) => column.name === columnName));
}

export function municipalityColumnsFirst(sourceProfile: SourceProfile): SourceColumn[] {
  const recognizedColumns = sourceProfile.columns.filter((column) => isMunicipalityColumn(column.name));
  return [...recognizedColumns, ...sourceProfile.columns.filter((column) => !isMunicipalityColumn(column.name))];
}

export function suggestedMunicipalityName(sourceProfile: SourceProfile) {
  const suggestedName = sourceProfile.suggestions.municipality_name;
  if (hasSourceColumn(sourceProfile, suggestedName)) return suggestedName ?? "";
  const suggestedCode = sourceProfile.suggestions.municipality_code;
  if (hasSourceColumn(sourceProfile, suggestedCode)) return suggestedCode ?? "";
  return sourceProfile.columns.find((column) => /(?:^|_)(?:municipio|municipios|nome_municipio|cidade)(?:_|$)/.test(normalizedColumnName(column.name)))?.name ?? "";
}

export function suggestedPeriodColumn(sourceProfile: SourceProfile, suggestedField: string | undefined) {
  return sourceProfile.columns.find((column) => isPeriodColumn(column.name) && column.name === suggestedField)?.name ?? "";
}

export function suggestedField(sourceProfile: SourceProfile, suggestionKey: string) {
  const suggestedColumn = sourceProfile.suggestions[suggestionKey];
  return hasSourceColumn(sourceProfile, suggestedColumn) ? suggestedColumn ?? "" : "";
}
