"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import styles from "../page.module.css";
import local from "./importacoes.module.css";
import { StatusNotice } from "../_components/status-notice";
import { ImportActionRow, type ActionOutcome } from "../_components/importacoes/acao-importacao";
import { ImportSummary } from "@/lib/types/importacao";
import { importErrorMessage } from "@/lib/import-error-message";
import { applyImportChange, availableActions, type LifecycleAction } from "@/lib/import-lifecycle";

const statusLabels: Record<ImportSummary["status"], string> = {
  draft: "Rascunho",
  analyzing: "Em análise",
  needs_review: "Aguardando revisão",
  approved: "Aprovada",
  archived: "Arquivada",
  discarded: "Descartada",
};

const statusFilters = [
  { value: "", label: "Todas (exceto descartadas)" },
  { value: "needs_review", label: "Aguardando revisão" },
  { value: "approved", label: "Aprovadas" },
  { value: "archived", label: "Arquivadas" },
];

const actionButtons: Record<LifecycleAction, { label: string; danger: boolean }> = {
  unapprove: { label: "Desfazer aprovação", danger: false },
  archive: { label: "Arquivar", danger: false },
  delete: { label: "Excluir", danger: true },
};

function formatDate(dateText: string) {
  return new Date(dateText).toLocaleString("pt-BR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function SavedImportsPage() {
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionMessageKind, setActionMessageKind] = useState<"error" | "success" | "warning">("success");
  const [pendingAction, setPendingAction] = useState<{ importId: string; action: LifecycleAction } | null>(null);
  const [isActionBusy, setIsActionBusy] = useState(false);

  const [reloadAttempt, setReloadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError("");
    fetch(`/api/imports${statusFilter ? `?status=${statusFilter}` : ""}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível carregar as importações salvas."));
        const payload: unknown = await response.json();
        if (!Array.isArray(payload)) throw new Error("A lista de importações veio em um formato inesperado.");
        return payload as ImportSummary[];
      })
      .then((importList) => { if (!cancelled) setImports(importList); })
      .catch((error: unknown) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : "Não foi possível acessar o serviço de tratamento."); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [statusFilter, reloadAttempt]);

  function reloadImports() {
    setReloadAttempt((attempt) => attempt + 1);
  }

  function finishAction(importId: string, outcome: ActionOutcome) {
    setImports((currentImports) => applyImportChange(currentImports, importId, outcome.change, statusFilter));
    setPendingAction(null);
    setActionMessageKind(outcome.kind);
    setActionMessage(outcome.text);
  }

  return <main className={styles.workspaceShell}>
    <section className={styles.workspaceIntro}>
      <p className={styles.eyebrow}>HISTÓRICO</p>
      <h1>Importações salvas</h1>
      <p>Reabra um rascunho para continuar a revisão, baixe a base importada, desfaça uma aprovação, arquive ou exclua o que não será mais usado.</p>
    </section>
    <section className={styles.tableWorkspace}>
      <div className={styles.tableHeading}>
        <div><p className={styles.eyebrow}>IMPORTAÇÕES</p><h2>Fontes guardadas</h2></div>
        <div className={styles.rowActions}>
          <button disabled={isLoading || isActionBusy} onClick={reloadImports} type="button"><RefreshCw size={14} /> Atualizar</button>
          <Link className={styles.primaryLink} href="/importar"><Plus size={16} />Nova importação</Link>
        </div>
      </div>
      <div className={styles.sourceForm}><label>Situação<select disabled={isActionBusy} onChange={(event) => { setPendingAction(null); setStatusFilter(event.target.value); }} value={statusFilter}>{statusFilters.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select></label></div>
      {actionMessage ? <StatusNotice variant={actionMessageKind}>{actionMessage}</StatusNotice> : null}
      {isLoading ? <StatusNotice variant="loading">Carregando as importações salvas.</StatusNotice> : null}
      {!isLoading && loadError ? <StatusNotice action={{ label: "Tentar novamente", onClick: reloadImports }} variant="error">{loadError}</StatusNotice> : null}
      {!isLoading && !loadError && !imports.length ? <p className={styles.profileGuidance}>Nenhuma importação encontrada{statusFilter ? " com essa situação" : ""}. Comece por uma nova importação.</p> : null}
      {!isLoading && !loadError && imports.length ? <div className={styles.tableWrap}><table>
        <thead><tr><th>Título</th><th>Situação</th><th>Linhas</th><th>Criada em</th><th>Ações</th></tr></thead>
        <tbody>{imports.map((savedImport) => <Fragment key={savedImport.id}>
          <tr>
            <td title={savedImport.file_name ?? undefined}>{savedImport.title}</td>
            <td><span className={styles.statusBadge} data-status={savedImport.status}>{statusLabels[savedImport.status] ?? savedImport.status}</span></td>
            <td>{savedImport.total_rows.toLocaleString("pt-BR")}</td>
            <td>{formatDate(savedImport.created_at)}</td>
            <td><div className={`${styles.rowActions} ${local.actions}`}>
              <Link href={{ pathname: "/importar", query: { importId: savedImport.id } }} onClick={(event) => { event.preventDefault(); window.location.assign(event.currentTarget.href); }}>Abrir</Link>
              <a href={`/api/imports/${encodeURIComponent(savedImport.id)}/export/csv`}>CSV</a>
              <a href={`/api/imports/${encodeURIComponent(savedImport.id)}/export/xlsx`}>XLSX</a>
              {availableActions(savedImport.status).map((action) => <button
                aria-expanded={pendingAction?.importId === savedImport.id && pendingAction.action === action}
                className={actionButtons[action].danger ? styles.dangerButton : undefined}
                disabled={isActionBusy}
                key={action}
                onClick={() => { setActionMessage(""); setPendingAction({ importId: savedImport.id, action }); }}
                type="button"
              >{actionButtons[action].label}</button>)}
            </div></td>
          </tr>
          {pendingAction?.importId === savedImport.id ? <ImportActionRow
            action={pendingAction.action}
            columns={5}
            key={pendingAction.action}
            onBusyChange={setIsActionBusy}
            onClose={() => setPendingAction(null)}
            onDone={(outcome) => finishAction(savedImport.id, outcome)}
            savedImport={savedImport}
          /> : null}
        </Fragment>)}</tbody>
      </table></div> : null}
    </section>
  </main>;
}
