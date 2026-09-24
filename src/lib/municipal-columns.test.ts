import { describe, expect, it } from "vitest";
import { isMunicipalityColumn, isPeriodColumn, municipalityColumnsFirst, suggestedField, suggestedMunicipalityName } from "./municipal-columns";
import { SourceProfile } from "@/lib/types/importacao";

function profileWith(columnNames: string[], suggestions: Record<string, string> = {}): SourceProfile {
  return { kind: "uploaded_file", file_name: "dados.csv", rows: 1, columns: columnNames.map((name) => ({ name, dtype: "String", null_count: 0 })), sample: [], suggestions };
}

describe("municipal columns", () => {
  it("recognizes municipality columns with accents and common synonyms", () => {
    expect(isMunicipalityColumn("Município")).toBe(true);
    expect(isMunicipalityColumn("codigo_ibge")).toBe(true);
    expect(isMunicipalityColumn("nome_cidade")).toBe(true);
    expect(isMunicipalityColumn("valor")).toBe(false);
  });

  it("recognizes monthly columns by month and year", () => {
    expect(isPeriodColumn("julho_2026_saldos")).toBe(true);
    expect(isPeriodColumn("Março_2024")).toBe(true);
    expect(isPeriodColumn("ano_2024")).toBe(false);
  });

  it("keeps every column available and lists recognized ones first", () => {
    const orderedNames = municipalityColumnsFirst(profileWith(["valor", "nome", "municipio"])).map((column) => column.name);
    expect(orderedNames).toEqual(["municipio", "valor", "nome"]);
  });

  it("only suggests fields that exist in the sheet", () => {
    const sourceProfile = profileWith(["cod", "ano"], { municipality_code: "cod", reference_year: "coluna_removida" });
    expect(suggestedField(sourceProfile, "municipality_code")).toBe("cod");
    expect(suggestedField(sourceProfile, "reference_year")).toBe("");
  });

  it("prefers the suggested municipality name column", () => {
    expect(suggestedMunicipalityName(profileWith(["municipio", "nome_mun"], { municipality_name: "nome_mun" }))).toBe("nome_mun");
    expect(suggestedMunicipalityName(profileWith(["cidade", "valor"]))).toBe("cidade");
  });

});
