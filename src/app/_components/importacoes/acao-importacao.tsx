"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../../page.module.css";
import local from "./acao-importacao.module.css";
import { StatusNotice } from "../status-notice";
import { importErrorMessage } from "@/lib/import-error-message";
import {
  archiveMessage,
  deleteMessage,
  deletionWarning,
  impactRows,
  titleMatches,
  unapproveMessage,
  type DeleteResult,
  type ImportChange,
  type ImportImpact,
  type LifecycleAction,
  type UnapproveResult,
} from "@/lib/import-lifecycle";
import type { ImportSummary } from "@/lib/types/importacao";

export type ActionOutcome = { change: ImportChange; kind: "success" | "warning"; text: string };

type ActionPanelProps = {
  savedImport: ImportSummary;
  action: LifecycleAction;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onDone: (outcome: ActionOutcome) => void;
};

const headings: Record<LifecycleAction, string> = {
  unapprove: "Desfazer a aprovação",
  archive: "Arquivar importação",
  delete: "Excluir importação",
};

const confirmLabels: Record<LifecycleAction, [string, string]> = {
  unapprove: ["Desfazer aprovação", "Desfazendo..."],
  archive: ["Arquivar", "Arquivando..."],
  delete: ["Excluir definitivamente", "Excluindo..."],
};

const explanations: Record<Exclude<LifecycleAction, "delete">, string> = {
  unapprove: "Os valores publicados por esta importação deixam de aparecer no painel e no cálculo do IIU. Nada é apagado: ela volta para “Aguardando revisão” e pode ser aprovada de novo.",
  archive: "A importação sai do painel e do cálculo do IIU, mas nada é apagado. Ela continua na lista, no filtro “Arquivadas”.",
};

export function ImportActionPanel({ savedImport, action, onBusyChange, onClose, onDone }: ActionPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [impact, setImpact] = useState<ImportImpact | null>(null);
  const [impactError, setImpactError] = useState("");
  const [impactAttempt, setImpactAttempt] = useState(0);
  const [typedTitle, setTypedTitle] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const importPath = `/api/imports/${encodeURIComponent(savedImport.id)}`;
  const isDelete = action === "delete";
  const isLoadingImpact = isDelete && !impact && !impactError;
  const canConfirm = !isRunning && (!isDelete || (impact !== null && titleMatches(typedTitle, savedImport.title)));

  useEffect(() => {
    panelRef.current?.scrollIntoView({ block: "nearest" });
    if (!isDelete) panelRef.current?.focus();
  }, [isDelete]);

  useEffect(() => {
    if (!isDelete) return;
    let cancelled = false;
    setImpact(null);
    setImpactError("");
    fetch(`${importPath}/impact`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível calcular o que será removido."));
        return (await response.json()) as ImportImpact;
      })
      .then((loadedImpact) => { if (!cancelled) setImpact(loadedImpact); })
      .catch((error: unknown) => { if (!cancelled) setImpactError(error instanceof Error ? error.message : "Não foi possível acessar o serviço de tratamento."); });
    return () => { cancelled = true; };
  }, [isDelete, importPath, impactAttempt]);

  const setBusy = useCallback((busy: boolean) => {
    setIsRunning(busy);
    onBusyChange(busy);
  }, [onBusyChange]);

  async function run() {
    setBusy(true);
    setErrorMessage("");
    try {
      if (action === "unapprove") {
        const response = await fetch(`${importPath}/unapprove`, { method: "POST" });
        if (!response.ok) { setErrorMessage(await importErrorMessage(response, "Não foi possível desfazer a aprovação.")); return; }
        const result = (await response.json()) as UnapproveResult;
        onDone({ change: { kind: "status", status: "needs_review" }, kind: "success", text: unapproveMessage(savedImport.title, result) });
      } else if (action === "archive") {
        const response = await fetch(`${importPath}/archive`, { method: "POST" });
        if (!response.ok) { setErrorMessage(await importErrorMessage(response, "Não foi possível arquivar a importação.")); return; }
        onDone({ change: { kind: "status", status: "archived" }, kind: "success", text: archiveMessage(savedImport.title) });
      } else {
        const force = savedImport.status === "approved" || impact?.status === "approved";
        const response = await fetch(`${importPath}${force ? "?force=true" : ""}`, { method: "DELETE" });
        if (!response.ok) { setErrorMessage(await importErrorMessage(response, "Não foi possível excluir a importação.")); return; }
        const result = (await response.json()) as DeleteResult;
        const message = deleteMessage(savedImport.title, result);
        onDone({ change: { kind: "remove" }, ...message });
      }
    } catch {
      setErrorMessage("Não foi possível acessar o serviço de tratamento. Atualize a lista para ver se a ação terminou.");
    } finally {
      setBusy(false);
    }
  }

  const warning = impact ? deletionWarning(impact) : null;

  return <div
    aria-labelledby={`acao-${savedImport.id}`}
    className={local.panel}
    data-action={action}
    onKeyDown={(event) => { if (event.key === "Escape" && !isRunning) onClose(); }}
    ref={panelRef}
    role="group"
    tabIndex={-1}
  >
    <h3 id={`acao-${savedImport.id}`}>{headings[action]}: {savedImport.title}</h3>
    {!isDelete ? <p>{explanations[action]}</p> : null}
    {isLoadingImpact ? <StatusNotice variant="loading">Calculando o que será removido.</StatusNotice> : null}
    {isDelete && impactError ? <StatusNotice action={{ label: "Tentar novamente", onClick: () => setImpactAttempt((attempt) => attempt + 1) }} variant="error">{impactError}</StatusNotice> : null}
    {isDelete && impact ? <>
      <p>A exclusão é definitiva e apaga a importação e tudo o que depende dela.</p>
      <dl className={local.impact}>{impactRows(impact).map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
      {impact.has_file ? <p>O arquivo original guardado também será removido.</p> : null}
      {warning ? <StatusNotice variant="warning">{warning}</StatusNotice> : null}
      <label className={local.confirm}>Para confirmar, digite o título da importação
        <input autoComplete="off" autoFocus onChange={(event) => setTypedTitle(event.target.value)} placeholder={savedImport.title} spellCheck={false} type="text" value={typedTitle} />
      </label>
    </> : null}
    {errorMessage ? <StatusNotice variant="error">{errorMessage}</StatusNotice> : null}
    <div className={styles.rowActions}>
      <button
        className={isDelete || action === "unapprove" ? styles.dangerButton : styles.primaryButton}
        disabled={!canConfirm}
        onClick={() => void run()}
        type="button"
      >{isRunning ? confirmLabels[action][1] : confirmLabels[action][0]}</button>
      <button disabled={isRunning} onClick={onClose} type="button">Cancelar</button>
    </div>
  </div>;
}

export function ImportActionRow({ columns, ...panelProps }: ActionPanelProps & { columns: number }) {
  return <tr><td className={local.cell} colSpan={columns}><ImportActionPanel {...panelProps} /></td></tr>;
}
