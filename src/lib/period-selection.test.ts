import { describe, expect, it } from "vitest";
import { effectiveGranularity, frequencyGranularity, isPeriodSelectionComplete, periodRequest, suggestedPeriod } from "./period-selection";
import { isAnnualPeriodColumn, isPeriodColumn } from "./municipal-columns";
import { SourceProfile } from "@/lib/types/importacao";

function profileWith(columnNames: string[], suggestions: Record<string, string> = {}): SourceProfile {
  return { kind: "uploaded_file", file_name: "dados.csv", rows: 1, columns: columnNames.map((name) => ({ name, dtype: "String", null_count: 0 })), sample: [], suggestions };
}

describe("period selection", () => {
  it("suggests the period layout from the column names", () => {
    expect(suggestedPeriod(profileWith(["municipio", "ano", "valor"])).mode).toBe("year_column");
    expect(suggestedPeriod(profileWith(["municipio", "mes", "ano", "valor"])).mode).toBe("month_year_columns");
    expect(suggestedPeriod(profileWith(["municipio", "competencia", "valor"]))).toMatchObject({ mode: "date_column", dateField: "competencia", granularity: "month" });
    expect(suggestedPeriod(profileWith(["municipio", "valor"])).mode).toBe("fixed");
  });

  it("requires every value the chosen layout needs", () => {
    const fixed = { ...suggestedPeriod(profileWith(["valor"])), fixedYear: "2024" };
    expect(isPeriodSelectionComplete(fixed)).toBe(true);
    expect(isPeriodSelectionComplete({ ...fixed, fixedYear: "24" })).toBe(false);
    expect(isPeriodSelectionComplete({ ...fixed, granularity: "month" })).toBe(false);
    expect(isPeriodSelectionComplete({ ...fixed, granularity: "month", fixedMonth: "3" })).toBe(true);
    expect(periodRequest({ ...fixed, granularity: "month", fixedMonth: "3" })).toMatchObject({ mode: "fixed", fixed_year: 2024, fixed_month: 3 });
  });

  it("derives granularity from the layout and from the indicator frequency", () => {
    const selection = suggestedPeriod(profileWith(["ano"]));
    expect(effectiveGranularity(selection, null)).toBe("year");
    expect(effectiveGranularity({ ...selection, mode: "prepared" }, "month")).toBe("month");
    expect(frequencyGranularity("Mensal")).toBe("month");
    expect(frequencyGranularity("anual")).toBe("year");
    expect(frequencyGranularity(null)).toBeNull();
  });

  it("recognizes monthly and annual period columns", () => {
    expect(isPeriodColumn("jul_2024_saldo")).toBe(true);
    expect(isPeriodColumn("primar_2020")).toBe(false);
    expect(isAnnualPeriodColumn("valor_2021")).toBe(true);
    expect(isAnnualPeriodColumn("2019")).toBe(true);
    expect(isAnnualPeriodColumn("julho_2024")).toBe(false);
  });
});
