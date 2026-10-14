import { describe, expect, it } from "vitest";
import { bestIndexes, compareQueryString, comparisonToCsv, parseCodesParam } from "./iiu-compare";
import { chartGeometry, numericPoints, summarizeSeries, timeseriesToCsv } from "./iiu-timeseries";
import { defaultDirection, nextSort, rankingQueryString, rankingToCsv } from "./iiu-ranking";
import type { IiuComparison, IiuRankingItem, IiuSeriesPoint, IiuTimeseries } from "./types/iiu-paineis";

const frame = { width: 400, height: 200, left: 40, right: 10, top: 10, bottom: 30 };

function point(reference_period: string, value: number | string | null): IiuSeriesPoint {
  return { reference_period, value, unit: "%", source_name: "RAIS", import_title: "Carga 1" };
}

describe("parseCodesParam", () => {
  it("mantém só códigos IBGE válidos, sem repetir, até quatro", () => {
    expect(parseCodesParam("3509502, 3509502,abc,123,4314902,3550308,3304557,5300108")).toEqual(["3509502", "4314902", "3550308", "3304557"]);
    expect(parseCodesParam(null)).toEqual([]);
  });
});

describe("compareQueryString", () => {
  it("junta os códigos com vírgula", () => {
    expect(new URLSearchParams(compareQueryString(["3509502", "4314902"], "grande")).get("codes")).toBe("3509502,4314902");
  });
});

describe("bestIndexes", () => {
  it("destaca o maior valor e ignora vazios e empates gerais", () => {
    expect(bestIndexes([50, 80, null])).toEqual(new Set([1]));
    expect(bestIndexes([80, 80])).toEqual(new Set());
    expect(bestIndexes([70, null])).toEqual(new Set());
    expect(bestIndexes([90, 90, 10])).toEqual(new Set([0, 1]));
  });
});

describe("comparisonToCsv", () => {
  it("traz nota geral, dimensões e indicadores lado a lado", () => {
    const indicator = (raw: number | null, score: number | null) => ({ code: "eco01", name: "Empregos", type: null, unit: "pessoas", direction: "higher", raw_value: raw, reference_period: raw === null ? null : "2023-01-01", score, benchmark: null });
    const municipality = (name: string, overall: number, raw: number | null) => ({ municipality_ibge_code: "1", name, state: "SP", overall_score: overall, maturity: null, observed_indicators: 1, scored_indicators: 1, total_indicators: 1, dimensions: [{ code: "eco", name: "Economia", color: "#fff", weight: 50, score: overall, scored_indicators: 1, observed_indicators: 1, total_indicators: 1, indicators: [indicator(raw, raw === null ? null : 40)] }] });
    const comparison: IiuComparison = { city_profile: "medio", municipalities: [municipality("Campinas", 70, 1200), municipality("Santos", 55, null)] };
    const lines = comparisonToCsv(comparison).split("\r\n");
    expect(lines[0]).toContain("Valor Campinas;Período Campinas;Nota Campinas;Valor Santos");
    expect(lines[1]).toBe("Nota geral;;;;;70;;;55");
    expect(lines[3]).toBe("Economia;Empregos;pessoas;1200;2023-01-01;40;;;");
  });
});

describe("numericPoints", () => {
  it("descarta valores não numéricos e converte textos", () => {
    const points = numericPoints([point("2020-01-01", "10,5".replace(",", ".")), point("2021-01-01", null), point("2022-01-01", "abc"), point("2023-01-01", 12)]);
    expect(points.map((item) => item.value)).toEqual([10.5, 12]);
    expect(points[0].label).toBe("2020");
  });
});

describe("summarizeSeries", () => {
  it("calcula variação, mínimo e máximo", () => {
    const summary = summarizeSeries(numericPoints([point("2020-01-01", 10), point("2021-01-01", 30), point("2022-01-01", 15)]));
    expect(summary?.change).toBe(5);
    expect(summary?.changePercent).toBe(50);
    expect(summary?.max.value).toBe(30);
    expect(summary?.min.period).toBe("2020-01-01");
  });

  it("não calcula percentual a partir de zero e devolve nulo sem pontos", () => {
    expect(summarizeSeries(numericPoints([point("2020-01-01", 0), point("2021-01-01", 5)]))?.changePercent).toBeNull();
    expect(summarizeSeries([])).toBeNull();
  });
});

describe("chartGeometry", () => {
  it("mantém todos os pontos dentro da área do gráfico", () => {
    const geometry = chartGeometry(numericPoints([point("2020-01-01", 10), point("2021-01-01", 30), point("2022-01-01", 20)]), frame);
    expect(geometry.dots).toHaveLength(3);
    for (const dot of geometry.dots) {
      expect(dot.x).toBeGreaterThanOrEqual(frame.left);
      expect(dot.x).toBeLessThanOrEqual(frame.width - frame.right);
      expect(dot.y).toBeGreaterThanOrEqual(frame.top);
      expect(dot.y).toBeLessThanOrEqual(frame.height - frame.bottom);
    }
    expect(geometry.path.startsWith("M")).toBe(true);
  });

  it("aceita um único ponto e valores iguais", () => {
    expect(chartGeometry(numericPoints([point("2020-01-01", 5)]), frame).dots).toHaveLength(1);
    const flat = chartGeometry(numericPoints([point("2020-01-01", 5), point("2021-01-01", 5)]), frame);
    expect(flat.yTicks.length).toBeGreaterThan(1);
    expect(flat.dots.every((dot) => Number.isFinite(dot.y))).toBe(true);
  });

  it("devolve vazio sem pontos", () => {
    expect(chartGeometry([], frame).path).toBe("");
  });
});

describe("timeseriesToCsv", () => {
  it("exporta um ponto por linha", () => {
    const series: IiuTimeseries = { municipality_ibge_code: "3509502", municipality_name: "Campinas", state: "SP", indicator: { code: "eco01", name: "Empregos", unit: "%" }, points: [point("2020-01-01", 10.5), point("2021-01-01", null)] };
    const lines = timeseriesToCsv(series).split("\r\n");
    expect(lines[1]).toBe("3509502;Campinas;SP;Empregos;2020-01-01;10,5;%;RAIS;Carga 1");
    expect(lines[2]).toContain("2021-01-01;;%");
  });
});

describe("ranking", () => {
  it("alterna a direção ao clicar de novo e usa a padrão ao trocar de coluna", () => {
    expect(defaultDirection("name")).toBe("asc");
    expect(defaultDirection("score")).toBe("desc");
    expect(nextSort({ key: "score", direction: "desc" }, "score")).toEqual({ key: "score", direction: "asc" });
    expect(nextSort({ key: "score", direction: "desc" }, "name")).toEqual({ key: "name", direction: "asc" });
  });

  it("monta a consulta só com o que foi preenchido", () => {
    const query = new URLSearchParams(rankingQueryString({ cityProfile: "grande", dimension: "", search: "  ", sort: { key: "score", direction: "desc" }, limit: 50, offset: 100 }));
    expect(Object.fromEntries(query)).toEqual({ city_profile: "grande", sort: "score", direction: "desc", limit: "50", offset: "100" });
    expect(rankingQueryString({ cityProfile: "medio", dimension: "eco", search: "cam", sort: { key: "name", direction: "asc" }, limit: 50, offset: 0, refresh: true })).toContain("refresh=true");
  });

  it("exporta posição, notas por dimensão e cobertura", () => {
    const item: IiuRankingItem = { rank: 1, score: 80, municipality_ibge_code: "3509502", name: "Campinas", state: "SP", overall_score: 71, maturity: "Nível 4", dimension_scores: { eco: 65, pes: null }, scored_indicators: 3, observed_indicators: 4 };
    const dimensions = [{ code: "eco", name: "Economia", color: "#f90", display_order: 1, weight: 60 }, { code: "pes", name: "Pessoas", color: "#f0f", display_order: 2, weight: 40 }];
    const lines = rankingToCsv([item], dimensions, undefined).split("\r\n");
    expect(lines[0]).toContain("Nota Economia;Nota Pessoas");
    expect(lines[1]).toBe("1;3509502;Campinas;SP;71;Nível 4;65;;3;4");
  });
});
