import type { ImportSummary } from "@/lib/types/importacao";

export type ImportStatus = ImportSummary["status"];
export type LifecycleAction = "unapprove" | "archive" | "delete";

export type ImportImpact = {
  import_id: string;
  title: string;
  status: ImportStatus;
  has_file: boolean;
  published_values: number;
  import_rows: number;
  import_sheets: number;
  validation_issues: number;
};

export type UnapproveResult = { import_id: string; status: "needs_review"; superseded_published_values: number; superseded_observations: number };

export type DeleteResult = {
  import_id: string;
  status: "deleted";
  deleted: Partial<Record<"published_values" | "observations" | "validation_issues" | "treatment_proposals" | "import_rows" | "import_sheets" | "imports" | "sources", number>>;
  storage_removed: boolean;
};

export type ImportChange = { kind: "status"; status: ImportStatus } | { kind: "remove" };

export function availableActions(status: ImportStatus): LifecycleAction[] {
  const actions: LifecycleAction[] = [];
  if (status === "approved") actions.push("unapprove");
  if (status !== "archived" && status !== "discarded") actions.push("archive");
  actions.push("delete");
  return actions;
}

export function titleMatches(typed: string, title: string): boolean {
  const expected = title.trim();
  return expected.length > 0 && typed.trim() === expected;
}

export function formatCount(value: number): string {
  return value.toLocaleString("pt-BR");
}

function counted(value: number, singular: string, plural: string): string {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

export function impactRows(impact: ImportImpact): { label: string; value: string }[] {
  return [
    { label: "Valores publicados", value: formatCount(impact.published_values) },
    { label: "Linhas importadas", value: formatCount(impact.import_rows) },
    { label: "Abas", value: formatCount(impact.import_sheets) },
    { label: "Pendências de validação", value: formatCount(impact.validation_issues) },
  ];
}

export function deletionWarning(impact: ImportImpact): string | null {
  if (impact.status === "approved") {
    return `Esta importação está aprovada: ${counted(impact.published_values, "valor publicado sai", "valores publicados saem")} do painel e do cálculo do IIU.`;
  }
  if (impact.published_values > 0) {
    return `${counted(impact.published_values, "valor publicado", "valores publicados")} por ela também ${impact.published_values === 1 ? "será apagado" : "serão apagados"}.`;
  }
  return null;
}

export function unapproveMessage(title: string, result: UnapproveResult): string {
  const base = `“${title}” voltou para “Aguardando revisão”.`;
  const removed = result.superseded_published_values;
  if (!removed) return `${base} Ela não tinha valores publicados no painel.`;
  return `${base} ${counted(removed, "valor deixou", "valores deixaram")} de aparecer no painel; aprove de novo para publicá-los.`;
}

export function archiveMessage(title: string): string {
  return `“${title}” foi arquivada e saiu do painel. Ela continua na lista, no filtro “Arquivadas”.`;
}

export function deleteMessage(title: string, result: DeleteResult): { kind: "success" | "warning"; text: string } {
  const removedRows = result.deleted.import_rows ?? 0;
  const removedValues = result.deleted.published_values ?? 0;
  const details = [counted(removedRows, "linha importada", "linhas importadas")];
  if (removedValues) details.push(counted(removedValues, "valor publicado", "valores publicados"));
  const participle = removedValues ? "removidos" : removedRows === 1 ? "removida" : "removidas";
  const text = `“${title}” foi excluída: ${details.join(" e ")} ${participle}.`;
  if (result.storage_removed) return { kind: "success", text };
  return { kind: "warning", text: `${text} O arquivo original não pôde ser removido do armazenamento; ele precisa ser apagado à mão no bucket source-files do Supabase.` };
}

export function applyImportChange(imports: ImportSummary[], importId: string, change: ImportChange, statusFilter: string): ImportSummary[] {
  if (change.kind === "remove") return imports.filter((savedImport) => savedImport.id !== importId);
  return imports.flatMap((savedImport) => {
    if (savedImport.id !== importId) return [savedImport];
    return statusFilter && statusFilter !== change.status ? [] : [{ ...savedImport, status: change.status }];
  });
}
