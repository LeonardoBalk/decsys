import { describe, expect, it } from "vitest";
import { applyImportChange, archiveMessage, availableActions, deleteMessage, deletionWarning, impactRows, titleMatches, unapproveMessage, type ImportImpact } from "./import-lifecycle";
import type { ImportSummary } from "./types/importacao";

const saved = (id: string, status: ImportSummary["status"]): ImportSummary => ({ id, title: `Importação ${id}`, file_name: null, source_url: null, status, total_rows: 10, created_at: "2026-01-01T00:00:00Z", updated_at: null });
const impact = (overrides: Partial<ImportImpact>): ImportImpact => ({ import_id: "a", title: "PIB 2023", status: "approved", has_file: true, published_values: 5570, import_rows: 5570, import_sheets: 1, validation_issues: 0, ...overrides });

describe("ações disponíveis por situação", () => {
  it("aprovada pode desfazer, arquivar e excluir", () => {
    expect(availableActions("approved")).toEqual(["unapprove", "archive", "delete"]);
  });

  it("aguardando revisão pode arquivar e excluir", () => {
    expect(availableActions("needs_review")).toEqual(["archive", "delete"]);
    expect(availableActions("draft")).toEqual(["archive", "delete"]);
  });

  it("arquivada e descartada só podem ser excluídas", () => {
    expect(availableActions("archived")).toEqual(["delete"]);
    expect(availableActions("discarded")).toEqual(["delete"]);
  });
});

describe("confirmação da exclusão", () => {
  it("exige o título exatamente, ignorando espaços nas pontas", () => {
    expect(titleMatches("PIB 2023", "PIB 2023")).toBe(true);
    expect(titleMatches("  PIB 2023 ", "PIB 2023")).toBe(true);
    expect(titleMatches("pib 2023", "PIB 2023")).toBe(false);
    expect(titleMatches("", "PIB 2023")).toBe(false);
    expect(titleMatches("", "")).toBe(false);
  });

  it("avisa que a importação aprovada tira valores do painel", () => {
    expect(deletionWarning(impact({}))).toBe("Esta importação está aprovada: 5.570 valores publicados saem do painel e do cálculo do IIU.");
    expect(deletionWarning(impact({ published_values: 1 }))).toBe("Esta importação está aprovada: 1 valor publicado sai do painel e do cálculo do IIU.");
  });

  it("avisa sobre valores publicados de importações que não estão aprovadas", () => {
    expect(deletionWarning(impact({ status: "archived", published_values: 3 }))).toBe("3 valores publicados por ela também serão apagados.");
    expect(deletionWarning(impact({ status: "archived", published_values: 1 }))).toBe("1 valor publicado por ela também será apagado.");
  });

  it("não alerta quando não há valores publicados", () => {
    expect(deletionWarning(impact({ status: "needs_review", published_values: 0 }))).toBeNull();
  });

  it("lista o impacto com separador de milhar", () => {
    expect(impactRows(impact({ import_rows: 12000, validation_issues: 2 }))).toEqual([
      { label: "Valores publicados", value: "5.570" },
      { label: "Linhas importadas", value: "12.000" },
      { label: "Abas", value: "1" },
      { label: "Pendências de validação", value: "2" },
    ]);
  });
});

describe("mensagens de resultado", () => {
  it("desfazer a aprovação diz quantos valores saíram do painel", () => {
    expect(unapproveMessage("PIB", { import_id: "a", status: "needs_review", superseded_published_values: 2, superseded_observations: 2 })).toContain("2 valores deixaram de aparecer no painel");
    expect(unapproveMessage("PIB", { import_id: "a", status: "needs_review", superseded_published_values: 1, superseded_observations: 1 })).toContain("1 valor deixou de aparecer no painel");
    expect(unapproveMessage("PIB", { import_id: "a", status: "needs_review", superseded_published_values: 0, superseded_observations: 0 })).toContain("não tinha valores publicados");
  });

  it("arquivar explica onde a importação continua", () => {
    expect(archiveMessage("PIB")).toContain("Arquivadas");
  });

  it("excluir resume o que foi removido", () => {
    const result = deleteMessage("PIB", { import_id: "a", status: "deleted", deleted: { import_rows: 5570, published_values: 5570 }, storage_removed: true });
    expect(result.kind).toBe("success");
    expect(result.text).toBe("“PIB” foi excluída: 5.570 linhas importadas e 5.570 valores publicados removidos.");
  });

  it("concorda o particípio quando só há linhas importadas", () => {
    expect(deleteMessage("PIB", { import_id: "a", status: "deleted", deleted: { import_rows: 1 }, storage_removed: true }).text).toBe("“PIB” foi excluída: 1 linha importada removida.");
    expect(deleteMessage("PIB", { import_id: "a", status: "deleted", deleted: { import_rows: 40 }, storage_removed: true }).text).toBe("“PIB” foi excluída: 40 linhas importadas removidas.");
  });

  it("excluir sem poder apagar o arquivo vira aviso com a instrução manual", () => {
    const result = deleteMessage("PIB", { import_id: "a", status: "deleted", deleted: { import_rows: 4 }, storage_removed: false });
    expect(result.kind).toBe("warning");
    expect(result.text).toContain("bucket source-files");
  });
});

describe("lista depois da ação", () => {
  const list = [saved("a", "approved"), saved("b", "needs_review")];

  it("remove a importação excluída", () => {
    expect(applyImportChange(list, "a", { kind: "remove" }, "").map((item) => item.id)).toEqual(["b"]);
  });

  it("atualiza a situação sem filtro", () => {
    expect(applyImportChange(list, "a", { kind: "status", status: "needs_review" }, "").map((item) => item.status)).toEqual(["needs_review", "needs_review"]);
  });

  it("tira da lista a importação que deixou de combinar com o filtro", () => {
    expect(applyImportChange(list, "a", { kind: "status", status: "archived" }, "approved").map((item) => item.id)).toEqual(["b"]);
  });

  it("mantém na lista quando a nova situação combina com o filtro", () => {
    expect(applyImportChange(list, "a", { kind: "status", status: "needs_review" }, "needs_review").map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("não altera as demais importações", () => {
    const result = applyImportChange(list, "a", { kind: "status", status: "archived" }, "");
    expect(result[1]).toBe(list[1]);
  });
});
