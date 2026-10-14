import { buildCsv, type CsvCell } from "@/lib/csv";
import type { IiuCityProfile, IiuDimensionMeta, IiuRankingItem } from "@/lib/types/iiu-paineis";

export type SortDirection = "asc" | "desc";
export type RankingSort = { key: string; direction: SortDirection };

export type RankingQuery = {
  cityProfile: IiuCityProfile;
  dimension: string;
  search: string;
  sort: RankingSort;
  limit: number;
  offset: number;
  refresh?: boolean;
};

export const defaultRankingSort: RankingSort = { key: "score", direction: "desc" };
export function defaultDirection(sortKey: string): SortDirection {
  return sortKey === "name" || sortKey === "state" ? "asc" : "desc";
}

export function nextSort(current: RankingSort, clickedKey: string): RankingSort {
  if (current.key === clickedKey) return { key: clickedKey, direction: current.direction === "asc" ? "desc" : "asc" };
  return { key: clickedKey, direction: defaultDirection(clickedKey) };
}

export function rankingQueryString(query: RankingQuery) {
  const parameters = new URLSearchParams({ city_profile: query.cityProfile, sort: query.sort.key, direction: query.sort.direction, limit: String(query.limit), offset: String(query.offset) });
  if (query.dimension) parameters.set("dimension", query.dimension);
  if (query.search.trim()) parameters.set("search", query.search.trim());
  if (query.refresh) parameters.set("refresh", "true");
  return parameters.toString();
}

export function rankingToCsv(items: IiuRankingItem[], dimensions: IiuDimensionMeta[], selectedDimension: IiuDimensionMeta | undefined) {
  const header = ["Posição", "Código IBGE", "Município", "UF", ...(selectedDimension ? [`Nota ${selectedDimension.name}`] : []), "Nota geral", "Nível de maturidade", ...dimensions.map((dimension) => `Nota ${dimension.name}`), "Indicadores com nota", "Indicadores com valor"];
  const rows: CsvCell[][] = items.map((item) => [item.rank, item.municipality_ibge_code, item.name, item.state, ...(selectedDimension ? [item.score] : []), item.overall_score, item.maturity, ...dimensions.map((dimension) => item.dimension_scores[dimension.code] ?? null), item.scored_indicators, item.observed_indicators]);
  return buildCsv(header, rows);
}
