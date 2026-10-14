"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import styles from "../../page.module.css";
import local from "./filtrar-linhas.module.css";
import { SourceProfile } from "@/lib/types/importacao";
import { importErrorMessage } from "@/lib/import-error-message";
import { runInBackground } from "@/lib/job-polling";
import { StatusNotice } from "../status-notice";

type FilterOperator = "eq" | "neq" | "in" | "gte" | "lte" | "contains";
type FilterDraft = { field: string; operator: FilterOperator; value: string };
type FilterResult = { sheet_name: string; total_rows: number; kept_rows: number; removed_rows: number };

const OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: "eq", label: "é igual a" },
  { value: "neq", label: "é diferente de" },
  { value: "in", label: "é um destes (separe por ;)" },
  { value: "contains", label: "contém" },
  { value: "gte", label: "é maior ou igual a" },
  { value: "lte", label: "é menor ou igual a" }
];

type FilterRowsProps = {
  importId: string;
  sheetName: string | null | undefined;
  columns: SourceProfile["columns"];
  onSheetCreated: (sheetName: string) => void;
};

export function FilterRows({ importId, sheetName, columns, onSheetCreated }: FilterRowsProps) {
  const [filters, setFilters] = useState<FilterDraft[]>([]);
  const [latestField, setLatestField] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [phase, setPhase] = useState("");
  const [fraction, setFraction] = useState(0);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const completeFilters = filters.filter((filter) => filter.field && (filter.value.trim() !== ""));
  const canRun = !isRunning && (completeFilters.length > 0 || latestField !== "");

  function updateFilter(index: number, patch: Partial<FilterDraft>) {
    setFilters((current) => current.map((filter, filterIndex) => filterIndex === index ? { ...filter, ...patch } : filter));
  }

  async function createFilteredSheet() {
    setIsRunning(true);
    setMessage(null);
    setPhase("Enviando o pedido");
    setFraction(0);
    try {
      const result = await runInBackground<FilterResult>(`/api/imports/${encodeURIComponent(importId)}/filter-rows`, { sheet_name: sheetName, filters: completeFilters, keep_latest_of: latestField || null }, {
        fallbackMessage: "Não foi possível filtrar as linhas.",
        errorMessage: (failed) => importErrorMessage(failed, "Não foi possível filtrar as linhas."),
        onProgress: (currentPhase, currentFraction) => { setPhase(currentPhase); setFraction(currentFraction); }
      });
      setMessage({ kind: "success", text: `Aba “${result.sheet_name}” criada com ${result.kept_rows.toLocaleString("pt-BR")} de ${result.total_rows.toLocaleString("pt-BR")} linhas. A aba original não foi alterada.` });
      onSheetCreated(result.sheet_name);
    } catch (filterError) {
      setMessage({ kind: "error", text: filterError instanceof Error ? filterError.message : "Não foi possível filtrar as linhas." });
    } finally {
      setIsRunning(false);
    }
  }

  return <details className={local.panel}>
    <summary>Filtrar linhas antes de gravar <span>opcional</span></summary>
    <div className={local.body}>
      <p className={styles.fieldNote}>Use quando a planilha tem várias linhas por município (por exemplo, uma por sexo, categoria ou ano). O Decsys cria uma aba nova só com as linhas que passam nos filtros; a original continua intacta.</p>
      {filters.map((filter, index) => <div className={local.filterRow} key={index}>
        <select aria-label="Coluna" onChange={(event) => updateFilter(index, { field: event.target.value })} value={filter.field}><option value="">Coluna…</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select>
        <select aria-label="Condição" onChange={(event) => updateFilter(index, { operator: event.target.value as FilterOperator })} value={filter.operator}>{OPERATORS.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}</select>
        <input aria-label="Valor" onChange={(event) => updateFilter(index, { value: event.target.value })} placeholder="Valor" value={filter.value} />
        <button aria-label="Remover filtro" className={local.iconButton} onClick={() => setFilters((current) => current.filter((_, filterIndex) => filterIndex !== index))} type="button"><Trash2 size={15} /></button>
      </div>)}
      <button className={styles.secondaryLink} disabled={filters.length >= 10 || isRunning} onClick={() => setFilters((current) => [...current, { field: "", operator: "eq", value: "" }])} type="button"><Plus size={15} />Adicionar filtro</button>
      <label className={local.latest}>Manter só o período mais recente, usando a coluna
        <select onChange={(event) => setLatestField(event.target.value)} value={latestField}><option value="">Não aplicar</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select>
      </label>
      {message ? <StatusNotice variant={message.kind}>{message.text}</StatusNotice> : null}
      {isRunning ? <div role="status"><StatusNotice variant="loading">{phase || "Filtrando"}…</StatusNotice><progress aria-label="Andamento do filtro" max={100} value={Math.round(fraction * 100)} /></div> : null}
      <button className={`${styles.primaryButton} ${local.run}`} disabled={!canRun} onClick={() => void createFilteredSheet()} type="button">{isRunning ? "Filtrando..." : "Criar aba filtrada"}</button>
    </div>
  </details>;
}
