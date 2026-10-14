import { describe, expect, it } from "vitest";
import { activeFilterCount, emptyReviewedFilters, normalizePeriodInput, periodFilterError, reviewedValuesQuery } from "./period-filter";

describe("normalizePeriodInput", () => {
  it("aceita ano, ano-mês e mês/ano", () => {
    expect(normalizePeriodInput("2023")).toBe("2023");
    expect(normalizePeriodInput("2023-5")).toBe("2023-05");
    expect(normalizePeriodInput("05/2023")).toBe("2023-05");
    expect(normalizePeriodInput("  ")).toBe("");
  });

  it("rejeita o que não é período", () => {
    expect(normalizePeriodInput("2023-13")).toBeNull();
    expect(normalizePeriodInput("13/2023")).toBeNull();
    expect(normalizePeriodInput("abc")).toBeNull();
    expect(normalizePeriodInput("23")).toBeNull();
  });
});

describe("periodFilterError", () => {
  it("avisa quando o início vem depois do fim", () => {
    expect(periodFilterError("2024", "2022")).toMatch(/anterior/);
    expect(periodFilterError("2022", "2024")).toBe("");
    expect(periodFilterError("2022-05", "")).toBe("");
    expect(periodFilterError("x", "")).toMatch(/Informe o período/);
  });
});

describe("reviewedValuesQuery", () => {
  it("envia só os filtros preenchidos", () => {
    expect(reviewedValuesQuery(emptyReviewedFilters, 200, 0)).toBe("limit=200&offset=0");
    const query = new URLSearchParams(reviewedValuesQuery({ indicatorCode: "eco01", municipalityCode: "3509502", dimension: "eco", periodFrom: "05/2022", periodTo: "2023", search: " emprego " }, 200, 400));
    expect(Object.fromEntries(query)).toEqual({ limit: "200", offset: "400", indicator_code: "eco01", municipality_code: "3509502", dimension: "eco", period_from: "2022-05", period_to: "2023", search: "emprego" });
  });

  it("conta filtros ativos", () => {
    expect(activeFilterCount({ ...emptyReviewedFilters, search: "a", dimension: "eco" })).toBe(2);
    expect(activeFilterCount(emptyReviewedFilters)).toBe(0);
  });
});
