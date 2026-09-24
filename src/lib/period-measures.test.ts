import { describe, expect, it } from "vitest";
import { expandedSheetGranularity, isExpandedPeriodSheet, parsePeriodColumn, periodMeasureGroups } from "./period-measures";
import { SourceProfile } from "@/lib/types/importacao";

function profileWith(columnNames: string[], sample: SourceProfile["sample"] = []): SourceProfile {
  return { kind: "uploaded_file", file_name: "caged.csv", rows: 1, columns: columnNames.map((name) => ({ name, dtype: "String", null_count: 0 })), sample, suggestions: {} };
}

describe("period measures", () => {
  it("reads the measure and period from wide CAGED-style titles", () => {
    expect(parsePeriodColumn("fevereiro_2020_variacao_relativa_(%)")).toEqual({ field: "fevereiro_2020_variacao_relativa_(%)", measure: "variacao_relativa_(%)", year: 2020, month: 2 });
    expect(parsePeriodColumn("valor_2021")).toEqual({ field: "valor_2021", measure: "valor", year: 2021, month: null });
    expect(parsePeriodColumn("acumulado_do_ano_(2026)_-_sem_ajustes_saldos")).toBeNull();
    expect(parsePeriodColumn("ultimos_12_meses**_(jul_25_a_jun_26)_-_sem_ajuste_saldos")).toBeNull();
  });

  it("groups every month of the same measure, in chronological order", () => {
    const columns = ["uf", "codigo_do_municipio", "municipio", "janeiro_2020_estoque", "janeiro_2020_saldos", "fevereiro_2020_saldos", "fevereiro_2020_estoque", "dezembro_2019_saldos", "fevereiro_2020_variacao_relativa_(%)", "acumulado_do_ano_(2026)_-_sem_ajustes_saldos"];
    const groups = periodMeasureGroups(profileWith(columns));
    expect(groups.map((group) => [group.label, group.fields.length, group.firstPeriod, group.lastPeriod])).toEqual([["saldos", 3, "12/2019", "02/2020"], ["estoque", 2, "01/2020", "02/2020"]]);
    expect(groups[0].fields).toEqual(["dezembro_2019_saldos", "janeiro_2020_saldos", "fevereiro_2020_saldos"]);
  });

  it("recognizes the sheet the Decsys creates and its granularity", () => {
    const expanded = profileWith(["uf", "municipio", "linha_original", "coluna_original", "competencia", "valor"], [{ competencia: "2020-01-01" }]);
    expect(isExpandedPeriodSheet(expanded)).toBe(true);
    expect(expandedSheetGranularity(expanded)).toBe("month");
    expect(expandedSheetGranularity({ ...expanded, sample: [{ competencia: "2021" }] })).toBe("year");
    expect(isExpandedPeriodSheet(profileWith(["competencia", "valor"]))).toBe(false);
  });
});
