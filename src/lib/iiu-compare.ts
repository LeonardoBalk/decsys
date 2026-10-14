import { buildCsv, type CsvCell } from "@/lib/csv";
import type { IiuComparison } from "@/lib/types/iiu-paineis";

export const minCompared = 2;
export const maxCompared = 4;

export function parseCodesParam(text: string | null | undefined): string[] {
  const codes = (text ?? "").split(",").map((code) => code.trim()).filter((code) => /^\d{7}$/.test(code));
  return [...new Set(codes)].slice(0, maxCompared);
}

export function compareQueryString(codes: string[], cityProfile: string) {
  return new URLSearchParams({ codes: codes.join(","), city_profile: cityProfile }).toString();
}

export function bestIndexes(values: (number | null)[]): Set<number> {
  const present = values.flatMap((value, index) => (value === null ? [] : [{ value, index }]));
  if (present.length < 2) return new Set();
  const top = Math.max(...present.map((entry) => entry.value));
  if (present.every((entry) => entry.value === top)) return new Set();
  return new Set(present.filter((entry) => entry.value === top).map((entry) => entry.index));
}

export function comparisonToCsv(comparison: IiuComparison) {
  const municipalities = comparison.municipalities;
  const label = (index: number) => municipalities[index].name ?? municipalities[index].municipality_ibge_code;
  const header = ["Dimensão", "Indicador", "Unidade", ...municipalities.flatMap((_, index) => [`Valor ${label(index)}`, `Período ${label(index)}`, `Nota ${label(index)}`])];
  const rows: CsvCell[][] = [["Nota geral", "", "", ...municipalities.flatMap((municipality) => ["", "", municipality.overall_score])]];
  for (const [dimensionIndex, dimension] of (municipalities[0]?.dimensions ?? []).entries()) {
    rows.push([dimension.name, "Nota da dimensão", "", ...municipalities.flatMap((municipality) => ["", "", municipality.dimensions[dimensionIndex]?.score ?? null])]);
    for (const indicator of dimension.indicators) {
      const matches = municipalities.map((municipality) => municipality.dimensions[dimensionIndex]?.indicators.find((candidate) => candidate.code === indicator.code));
      rows.push([dimension.name, indicator.name, indicator.unit, ...matches.flatMap((match) => [match?.raw_value ?? null, match?.reference_period ?? null, match?.score ?? null])]);
    }
  }
  return buildCsv(header, rows);
}
