import { describe, expect, it } from "vitest";
import { buildCsv, csvCell, csvFileName } from "./csv";

describe("csvCell", () => {
  it("usa vírgula decimal e deixa vazio o que não tem valor", () => {
    expect(csvCell(12.5)).toBe("12,5");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
  });

  it("protege campos com ponto e vírgula, aspas ou quebra de linha", () => {
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""');
    expect(csvCell("duas\nlinhas")).toBe('"duas\nlinhas"');
    expect(csvCell("São Paulo")).toBe("São Paulo");
  });

  it("não deixa textos virarem fórmulas na planilha", () => {
    expect(csvCell("=SOMA(A1:A2)")).toBe("'=SOMA(A1:A2)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@usuario")).toBe("'@usuario");
    expect(csvCell("-")).toBe("'-");
  });
});

describe("buildCsv", () => {
  it("começa com BOM, separa por ponto e vírgula e usa CRLF", () => {
    const csv = buildCsv(["Município", "Nota"], [["Campinas", 71.25], ["Santos", null]]);
    expect(csv).toBe("﻿Município;Nota\r\nCampinas;71,25\r\nSantos;\r\n");
  });
});

describe("csvFileName", () => {
  it("gera um nome simples, sem acentos, com a data de hoje", () => {
    expect(csvFileName("ranking-iiu", "médio", null, "Qualidade de Vida")).toMatch(/^ranking-iiu-medio-qualidade-de-vida-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
