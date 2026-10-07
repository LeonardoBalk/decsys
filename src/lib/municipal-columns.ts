import { SourceProfile } from "@/lib/types/importacao";

type SourceColumn = SourceProfile["columns"][number];

export function normalizedColumnName(columnName: string) {
  return columnName.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function isPeriodColumn(columnName: string) {
  return /(?:^|_)(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)_(?:19|20)\d{2}(?:_|$)/.test(normalizedColumnName(columnName));
}

export function isAnnualPeriodColumn(columnName: string) {
  const normalizedName = normalizedColumnName(columnName).replace(/[^\p{L}\p{N}]+/gu, "_");
  return !isPeriodColumn(columnName)
    && !/(?:^|_)(?:maiores|menores|numero_de_municipios|participacao|posicao)(?:_|$)/.test(normalizedName)
    && /(?:^|_)(?:19|20)\d{2}(?:_|$)/.test(normalizedName);
}

export function isMunicipalityColumn(columnName: string) {
  const normalizedName = normalizedColumnName(columnName).replace(/[^\p{L}\p{N}]+/gu, "_");
  if (/(?:^|_)(?:maiores|menores|numero_de_municipios|participacao|posicao|total)(?:_|$)/.test(normalizedName)) return false;
  return /(?:^|_)(?:municipio|municipios|municipality|ibge|cod_mun|codigo_municipal|cidade|cidades|localidade|nome_mun|nome_municipio)(?:_|$)/.test(normalizedName);
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
  if (hasSourceColumn(sourceProfile, suggestedName) && isMunicipalityColumn(suggestedName ?? "")) return suggestedName ?? "";
  const suggestedCode = sourceProfile.suggestions.municipality_code;
  if (hasSourceColumn(sourceProfile, suggestedCode) && isMunicipalityColumn(suggestedCode ?? "")) return suggestedCode ?? "";
  return sourceProfile.columns.find((column) => isMunicipalityColumn(column.name))?.name ?? "";
}

export function suggestedPeriodColumn(sourceProfile: SourceProfile, suggestedField: string | undefined) {
  return sourceProfile.columns.find((column) => isPeriodColumn(column.name) && column.name === suggestedField)?.name ?? "";
}

export function suggestedField(sourceProfile: SourceProfile, suggestionKey: string) {
  const suggestedColumn = sourceProfile.suggestions[suggestionKey];
  return hasSourceColumn(sourceProfile, suggestedColumn) ? suggestedColumn ?? "" : "";
}
