import { describe, expect, it } from "vitest";
import { collectionItems } from "./coleta-catalog";
import { collectionCodeFor, countWithoutData, coverageByCode, coverageDetail, coverageLabel, coveragePeriod, hasData, type CoverageEntry } from "./coleta-coverage";

const entry = (overrides: Partial<CoverageEntry>): CoverageEntry => ({ indicator_code: "eco01_pib_municipal_per_capita", municipalities: 5570, value_count: 11140, first_period: "2022-01-01", last_period: "2023-01-01", ...overrides });

describe("código da matriz a partir do indicador publicado", () => {
  it("usa o prefixo PREFIXO+número em maiúsculas", () => {
    expect(collectionCodeFor("eco01_pib_municipal_per_capita")).toBe("ECO01");
    expect(collectionCodeFor("idd12_estabelecimentos_de_saude_com_conectividade_sist")).toBe("IDD12");
    expect(collectionCodeFor("QVI07_algo")).toBe("QVI07");
  });

  it("mantém o código inteiro quando não segue o padrão da matriz", () => {
    expect(collectionCodeFor("indicador_proprio")).toBe("INDICADOR_PROPRIO");
    expect(collectionCodeFor("ECO01")).toBe("ECO01");
  });

  it("todo código do catálogo é reconhecido pelo prefixo de um indicador publicado", () => {
    for (const item of collectionItems) expect(collectionCodeFor(`${item.code.toLowerCase()}_qualquer_nome`), item.code).toBe(item.code);
  });
});

describe("cobertura por indicador", () => {
  it("indexa pelo código da matriz e responde sem diferenciar maiúsculas", () => {
    const coverage = coverageByCode([entry({})]);
    expect(hasData("ECO01", coverage)).toBe(true);
    expect(hasData("eco01", coverage)).toBe(true);
    expect(hasData("ECO02", coverage)).toBe(false);
  });

  it("junta indicadores que compartilham o mesmo código da matriz", () => {
    const coverage = coverageByCode([
      entry({ indicator_code: "eco01_a", municipalities: 100, value_count: 100, first_period: "2021-01-01", last_period: "2021-01-01" }),
      entry({ indicator_code: "eco01_b", municipalities: 80, value_count: 160, first_period: "2022-01-01", last_period: "2023-01-01" }),
    ]);
    expect(coverage.get("ECO01")).toEqual({ municipalities: 100, values: 260, firstPeriod: "2021-01-01", lastPeriod: "2023-01-01" });
  });

  it("entrada sem nenhum valor não conta como dado", () => {
    expect(hasData("ECO01", coverageByCode([entry({ municipalities: 0, value_count: 0 })]))).toBe(false);
  });

  it("conta os indicadores sem dados", () => {
    const coverage = coverageByCode([entry({}), entry({ indicator_code: "pes01_taxa" })]);
    expect(countWithoutData(collectionItems, coverage)).toBe(collectionItems.length - 2);
    expect(countWithoutData([], coverage)).toBe(0);
  });
});

describe("textos dos selos", () => {
  const coverage = { municipalities: 5570, values: 11140, firstPeriod: "2022-01-01", lastPeriod: "2023-01-01" };

  it("mostra quantos municípios já foram importados", () => {
    expect(coverageLabel(coverage)).toBe("Importado: 5.570 municípios");
    expect(coverageLabel({ ...coverage, municipalities: 1 })).toBe("Importado: 1 município");
  });

  it("sem município na dimensão, mostra os valores", () => {
    expect(coverageLabel({ ...coverage, municipalities: 0, values: 3 })).toBe("Importado: 3 valores");
    expect(coverageLabel({ ...coverage, municipalities: 0, values: 1 })).toBe("Importado: 1 valor");
  });

  it("resume o período anual e o mensal", () => {
    expect(coveragePeriod(coverage)).toBe("2022 a 2023");
    expect(coveragePeriod({ ...coverage, lastPeriod: "2022-01-01" })).toBe("2022");
    expect(coveragePeriod({ ...coverage, firstPeriod: null })).toBeNull();
    expect(coveragePeriod({ ...coverage, firstPeriod: "2022-03-01", lastPeriod: "2022-09-01" })).toMatch(/2022/);
  });

  it("detalha valores e período", () => {
    expect(coverageDetail(coverage)).toBe("11.140 valores publicados · período 2022 a 2023");
    expect(coverageDetail({ ...coverage, values: 1, firstPeriod: null })).toBe("1 valor publicado");
  });
});
