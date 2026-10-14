import { describe, expect, it } from "vitest";
import type { Indicator } from "@/lib/types/importacao";
import { groupByDimension, normalizeSearchText, searchIndicators, shortIndicatorCode } from "./indicator-search";

const indicator = (code: string, name: string, dimension: string, unit = "%"): Indicator => ({ id: code, code, name, dimension, unit });
const catalog = [
  indicator("eco01_pib_municipal_per_capita", "ECO01 — PIB municipal per capita", "Economia", "R$/hab."),
  indicator("eco07_facilidade_para_abertura_de_empresas", "ECO07 — Facilidade para abertura de empresas", "Economia", "dias"),
  indicator("pes01_taxa_de_alfabetizacao", "PES01 — Taxa de alfabetização", "Pessoas"),
  indicator("qvi02_cobertura_da_atencao_primaria_esf", "QVI02 — Cobertura da Atenção Primária/ESF", "Qualidade de Vida"),
  indicator("idd08_maturidade_do_portal_de_dados_abertos", "IDD08 — Maturidade do portal de dados abertos", "Infraestrutura Digital e Dados"),
  indicator("gov02_maturidade_do_portal_de_dados_abertos", "GOV02 — Maturidade do portal de dados abertos", "Governança")
];

describe("busca de indicadores", () => {
  it("ignora acentos, maiúsculas e pontuação", () => {
    expect(normalizeSearchText("  Alfabetização — 14+ ")).toBe("alfabetizacao 14");
    expect(searchIndicators(catalog, "ATENCAO primaria").map((item) => item.code)).toEqual(["qvi02_cobertura_da_atencao_primaria_esf"]);
  });

  it("exige todas as palavras, em qualquer ordem", () => {
    expect(searchIndicators(catalog, "empresas abertura").map((item) => item.code)).toEqual(["eco07_facilidade_para_abertura_de_empresas"]);
    expect(searchIndicators(catalog, "pib saude")).toEqual([]);
  });

  it("acha pela sigla, pela dimensão e pela unidade", () => {
    expect(searchIndicators(catalog, "eco01")[0].code).toBe("eco01_pib_municipal_per_capita");
    expect(searchIndicators(catalog, "governanca").map((item) => item.code)).toEqual(["gov02_maturidade_do_portal_de_dados_abertos"]);
    expect(searchIndicators(catalog, "dias").map((item) => item.code)).toEqual(["eco07_facilidade_para_abertura_de_empresas"]);
  });

  it("coloca primeiro quem começa pelo termo e mantém a lista inteira sem busca", () => {
    expect(searchIndicators(catalog, "eco").slice(0, 2).map((item) => item.code)).toEqual(["eco01_pib_municipal_per_capita", "eco07_facilidade_para_abertura_de_empresas"]);
    expect(searchIndicators(catalog, "")).toHaveLength(catalog.length);
  });

  it("distingue indicadores de mesmo nome por dimensão e código", () => {
    const found = searchIndicators(catalog, "maturidade portal");
    expect(found.map((item) => shortIndicatorCode(item.code)).sort()).toEqual(["GOV02", "IDD08"]);
  });

  it("agrupa por dimensão na ordem de chegada", () => {
    const groups = groupByDimension(catalog);
    expect(groups.map((group) => group.dimension)).toEqual(["Economia", "Pessoas", "Qualidade de Vida", "Infraestrutura Digital e Dados", "Governança"]);
    expect(groups[0].indicators).toHaveLength(2);
  });

  it("encurta códigos da matriz e preserva os demais", () => {
    expect(shortIndicatorCode("amb13_ocorrencias")).toBe("AMB13");
    expect(shortIndicatorCode("cobertura_vacinal")).toBe("cobertura_vacinal");
  });
});
