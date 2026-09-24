import { normalizedColumnName } from "@/lib/municipal-columns";
import { SourceProfile } from "@/lib/types/importacao";

export type PeriodMeasureGroup = { key: string; label: string; fields: string[]; granularity: "month" | "year"; firstPeriod: string; lastPeriod: string };

const monthPattern = "janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez";
const monthNumbers: Record<string, number> = { janeiro: 1, jan: 1, fevereiro: 2, fev: 2, marco: 3, mar: 3, abril: 4, abr: 4, maio: 5, mai: 5, junho: 6, jun: 6, julho: 7, jul: 7, agosto: 8, ago: 8, setembro: 9, set: 9, outubro: 10, out: 10, novembro: 11, nov: 11, dezembro: 12, dez: 12 };

type ParsedPeriodColumn = { field: string; measure: string; year: number; month: number | null };

export function parsePeriodColumn(columnName: string): ParsedPeriodColumn | null {
  const normalizedName = normalizedColumnName(columnName);
  const monthlyMatch = new RegExp(`(?:^|_)(${monthPattern})_((?:19|20)\\d{2})(?:_|$)`).exec(normalizedName);
  if (monthlyMatch) {
    const measure = normalizedName.replace(monthlyMatch[0], "_").replace(/^_+|_+$/g, "");
    return { field: columnName, measure, year: Number(monthlyMatch[2]), month: monthNumbers[monthlyMatch[1]] };
  }
  const annualMatch = /(?:^|_)((?:19|20)\d{2})(?:_|$)/.exec(normalizedName);
  if (annualMatch) {
    const measure = normalizedName.replace(annualMatch[0], "_").replace(/^_+|_+$/g, "");
    return { field: columnName, measure, year: Number(annualMatch[1]), month: null };
  }
  return null;
}

function periodLabel(column: ParsedPeriodColumn) {
  return column.month ? `${String(column.month).padStart(2, "0")}/${column.year}` : String(column.year);
}

export function periodMeasureGroups(sourceProfile: SourceProfile): PeriodMeasureGroup[] {
  const groups = new Map<string, ParsedPeriodColumn[]>();
  for (const column of sourceProfile.columns) {
    const parsedColumn = parsePeriodColumn(column.name);
    if (!parsedColumn) continue;
    const key = `${parsedColumn.month ? "month" : "year"}:${parsedColumn.measure}`;
    groups.set(key, [...(groups.get(key) ?? []), parsedColumn]);
  }
  return [...groups.entries()]
    .filter(([, columns]) => columns.length >= 2)
    .map(([key, columns]) => {
      const ordered = [...columns].sort((first, second) => first.year - second.year || (first.month ?? 0) - (second.month ?? 0));
      const measure = ordered[0].measure;
      return {
        key,
        label: measure ? measure.replace(/_/g, " ") : "valor",
        fields: ordered.map((column) => column.field),
        granularity: ordered[0].month ? "month" as const : "year" as const,
        firstPeriod: periodLabel(ordered[0]),
        lastPeriod: periodLabel(ordered[ordered.length - 1]),
      };
    })
    .sort((first, second) => second.fields.length - first.fields.length || first.label.localeCompare(second.label, "pt-BR"));
}

export function isExpandedPeriodSheet(sourceProfile: SourceProfile) {
  const columnNames = new Set(sourceProfile.columns.map((column) => column.name));
  return columnNames.has("competencia") && columnNames.has("coluna_original") && columnNames.has("linha_original");
}

export function expandedSheetGranularity(sourceProfile: SourceProfile): "month" | "year" {
  return sourceProfile.sample.some((row) => /^\d{4}-\d{2}-\d{2}$/.test(String(row.competencia ?? ""))) ? "month" : "year";
}
