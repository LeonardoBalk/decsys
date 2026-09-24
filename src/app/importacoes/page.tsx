"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import styles from "../page.module.css";
import { StatusNotice } from "../_components/status-notice";
import { ImportSummary } from "@/lib/types/importacao";
import { importErrorMessage } from "@/lib/import-error-message";

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

function formatDate(dateText: string) {
  return new Date(dateText).toLocaleString("pt-BR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function SavedImportsPage() {
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionMessageKind, setActionMessageKind] = useState<"error" | "success">("success");
  const [discardingId, setDiscardingId] = useState<string | null>(null);

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

  async function discardImport(savedImport: ImportSummary) {
    if (!window.confirm(`Descartar "${savedImport.title}"? As linhas importadas e o arquivo guardado serão removidos do Decsys.`)) return;
    setDiscardingId(savedImport.id);
    setActionMessage("");
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(savedImport.id)}/discard`, { method: "POST" });
      if (!response.ok) {
        setActionMessageKind("error");
        setActionMessage(await importErrorMessage(response, "Não foi possível descartar a importação."));
        return;
      }
      setImports((currentImports) => currentImports.filter((currentImport) => currentImport.id !== savedImport.id));
      setActionMessageKind("success");
      setActionMessage(`"${savedImport.title}" foi descartada.`);
    } catch {
      setActionMessageKind("error");
      setActionMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setDiscardingId(null);
    }
  }

  return <main className={styles.workspaceShell}>
    <section className={styles.workspaceIntro}>
      <p className={styles.eyebrow}>HISTÓRICO</p>
      <h1>Importações salvas</h1>
      <p>Reabra um rascunho para continuar a revisão, baixe a base importada ou descarte o que não será usado.</p>
    </section>
    <section className={styles.tableWorkspace}>
      <div className={styles.tableHeading}>
        <div><p className={styles.eyebrow}>IMPORTAÇÕES</p><h2>Fontes guardadas</h2></div>
        <div className={styles.rowActions}>
          <button disabled={isLoading} onClick={reloadImports} type="button"><RefreshCw size={14} /> Atualizar</button>
          <Link className={styles.primaryLink} href="/"><Plus size={16} />Nova importação</Link>
        </div>
      </div>
      <div className={styles.sourceForm}><label>Situação<select onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>{statusFilters.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select></label></div>
      {actionMessage ? <StatusNotice variant={actionMessageKind}>{actionMessage}</StatusNotice> : null}
      {isLoading ? <StatusNotice variant="loading">Carregando as importações salvas.</StatusNotice> : null}
      {!isLoading && loadError ? <StatusNotice action={{ label: "Tentar novamente", onClick: reloadImports }} variant="error">{loadError}</StatusNotice> : null}
      {!isLoading && !loadError && !imports.length ? <p className={styles.profileGuidance}>Nenhuma importação encontrada{statusFilter ? " com essa situação" : ""}. Comece por uma nova importação.</p> : null}
      {!isLoading && !loadError && imports.length ? <div className={styles.tableWrap}><table>
        <thead><tr><th>Título</th><th>Situação</th><th>Linhas</th><th>Criada em</th><th>Ações</th></tr></thead>
        <tbody>{imports.map((savedImport) => <tr key={savedImport.id}>
          <td title={savedImport.file_name ?? undefined}>{savedImport.title}</td>
          <td><span className={styles.statusBadge} data-status={savedImport.status}>{statusLabels[savedImport.status] ?? savedImport.status}</span></td>
          <td>{savedImport.total_rows.toLocaleString("pt-BR")}</td>
          <td>{formatDate(savedImport.created_at)}</td>
          <td><div className={styles.rowActions}>
            <Link href={{ pathname: "/", query: { importId: savedImport.id } }}>Abrir</Link>
            <a href={`/api/imports/${encodeURIComponent(savedImport.id)}/export/csv`}>CSV</a>
            <a href={`/api/imports/${encodeURIComponent(savedImport.id)}/export/xlsx`}>XLSX</a>
            {savedImport.status !== "approved" ? <button className={styles.dangerButton} disabled={discardingId === savedImport.id} onClick={() => void discardImport(savedImport)} type="button">{discardingId === savedImport.id ? "Descartando..." : "Descartar"}</button> : null}
          </div></td>
        </tr>)}</tbody>
      </table></div> : null}
    </section>
  </main>;
}
