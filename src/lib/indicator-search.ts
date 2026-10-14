import type { Indicator } from "@/lib/types/importacao";

export type IndicatorGroup = { dimension: string; indicators: Indicator[] };

export function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function searchableText(indicator: Indicator): string {
  return normalizeSearchText(`${indicator.code} ${indicator.name} ${indicator.dimension ?? ""} ${indicator.unit}`);
}

/** Todas as palavras digitadas precisam aparecer (em qualquer ordem). Sigla no começo do código vem primeiro. */
export function searchIndicators(indicators: Indicator[], query: string): Indicator[] {
  const terms = normalizeSearchText(query).split(" ").filter(Boolean);
  if (!terms.length) return indicators;
  const matches = indicators.filter((indicator) => {
    const text = searchableText(indicator);
    return terms.every((term) => text.includes(term));
  });
  const firstTerm = terms[0];
  const rank = (indicator: Indicator) => {
    const code = normalizeSearchText(indicator.code);
    if (code === firstTerm) return 0;
    if (code.startsWith(firstTerm)) return 1;
    if (normalizeSearchText(indicator.name).startsWith(firstTerm)) return 2;
    return 3;
  };
  return [...matches].sort((left, right) => rank(left) - rank(right));
}

/** Agrupa por dimensão mantendo a ordem em que cada dimensão aparece na lista recebida. */
export function groupByDimension(indicators: Indicator[]): IndicatorGroup[] {
  const groups = new Map<string, Indicator[]>();
  for (const indicator of indicators) {
    const dimension = indicator.dimension?.trim() || "Sem dimensão";
    groups.set(dimension, [...(groups.get(dimension) ?? []), indicator]);
  }
  return [...groups.entries()].map(([dimension, items]) => ({ dimension, indicators: items }));
}

/** Código curto exibido ao lado do nome: "eco01_pib_..." vira "ECO01"; códigos antigos ficam como estão. */
export function shortIndicatorCode(code: string): string {
  const match = /^([a-z]{3}\d{2})_/.exec(code);
  return match ? match[1].toUpperCase() : code;
}
