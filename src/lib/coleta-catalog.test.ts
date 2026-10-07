import { describe, expect, it } from "vitest";
import { collectionDimensions, collectionItems, countByAccess, importHref, isHttpsUrl } from "./coleta-catalog";

describe("catálogo de coleta da matriz", () => {
  it("cobre as 7 dimensões e todos os indicadores da matriz", () => {
    expect(collectionDimensions()).toEqual(["Economia", "Pessoas", "Governança", "Mobilidade", "Ambiente", "Qualidade de Vida", "Infraestrutura Digital e Dados"]);
    expect(collectionItems).toHaveLength(102);
  });

  it("não repete códigos e segue o padrão PREFIXO+número", () => {
    const codes = collectionItems.map((item) => item.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^(ECO|PES|GOV|MOB|AMB|QVI|IDD)\d{2}$/);
  });

  it("todo indicador tem forma de acesso e instrução", () => {
    for (const item of collectionItems) {
      expect(["link", "manual", "local"], item.code).toContain(item.access);
      expect(item.steps.trim().length, `${item.code} sem steps`).toBeGreaterThan(10);
      expect(Array.isArray(item.needs), item.code).toBe(true);
      expect(item.verifiedOn, item.code).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("indicadores por link trazem URL HTTPS e os demais não prometem importação direta", () => {
    for (const item of collectionItems) {
      if (item.access === "link") expect(isHttpsUrl(item.importUrl), `${item.code} sem importUrl https`).toBe(true);
      else expect(item.importUrl, `${item.code} não deveria ter importUrl`).toBeUndefined();
      if (item.access === "manual") expect(isHttpsUrl(item.manualUrl), `${item.code} sem manualUrl https`).toBe(true);
    }
  });

  it("totaliza os três tipos de acesso", () => {
    const totals = countByAccess();
    expect(totals.link + totals.manual + totals.local).toBe(collectionItems.length);
  });

  it("monta o link de importação com a URL escapada", () => {
    expect(importHref("https://apisidra.ibge.gov.br/values/t/5938/n6/all?a=1&b=2")).toBe("/importar?link=https%3A%2F%2Fapisidra.ibge.gov.br%2Fvalues%2Ft%2F5938%2Fn6%2Fall%3Fa%3D1%26b%3D2");
    expect(isHttpsUrl("http://x.com")).toBe(false);
    expect(isHttpsUrl("lixo")).toBe(false);
  });
});
