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

  it("does not treat rankings or state totals as municipality columns", () => {
    expect(isMunicipalityColumn("posicao_ocupada_pelos_100_maiores_municipios")).toBe(false);
    expect(isMunicipalityColumn("unidades_da_federacao_numero_de_municipios")).toBe(false);
    expect(isMunicipalityColumn("unidades_da_federacao_(numero_de_municipios_(1))")).toBe(false);
    expect(isMunicipalityColumn("municipios_e_respectivas_unidades_da_federacao")).toBe(true);
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


  it("ignores saved suggestions that describe rankings and state totals", () => {
    const sourceProfile = profileWith(
      ["municipios_e_respectivas_unidades_da_federacao", "posicao_ocupada_pelos_100_maiores_municipios"],
      { municipality_name: "posicao_ocupada_pelos_100_maiores_municipios" },
    );
    const stateProfile = profileWith(
      ["unidades_da_federacao_(numero_de_municipios_(1))", "cinco_municipios_com_maiores_pibs_participacao"],
      { municipality_name: "unidades_da_federacao_(numero_de_municipios_(1))" },
    );
    expect(suggestedMunicipalityName(sourceProfile)).toBe("municipios_e_respectivas_unidades_da_federacao");
    expect(suggestedMunicipalityName(stateProfile)).toBe("");
  });
});
