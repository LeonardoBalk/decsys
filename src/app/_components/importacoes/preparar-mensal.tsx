import { useEffect, useState } from "react";
import styles from "../../page.module.css";
import { SourceProfile } from "@/lib/types/importacao";
import { importErrorMessage } from "@/lib/import-error-message";
import { PeriodGranularity } from "@/lib/period-selection";
import { PeriodMeasureGroup } from "@/lib/period-measures";
import { StatusNotice } from "../status-notice";

export type PreparedPeriodFields = { municipality_field: string; year_field: string; value_field: string; granularity: PeriodGranularity };

type PeriodColumnsPreparationProps = {
  importId: string;
  sheetName: string | null | undefined;
  monthlyColumns: SourceProfile["columns"];
  annualColumns: SourceProfile["columns"];
  measureGroups: PeriodMeasureGroup[];
  municipalityField: string;
  initialMeasureField: string;
  onPrepared: (fields: PreparedPeriodFields) => void;
  onSheetCreated: (sheetName: string) => void;
};

function formatPreparedPeriod(referencePeriod: string, granularity: PeriodGranularity) {
  if (granularity === "year") return referencePeriod;
  return new Date(`${referencePeriod}T12:00:00`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
}

export function PeriodColumnsPreparation({ importId, sheetName, monthlyColumns, annualColumns, measureGroups, municipalityField, initialMeasureField, onPrepared, onSheetCreated }: PeriodColumnsPreparationProps) {
  const [measureField, setMeasureField] = useState(initialMeasureField);
  const [groupKey, setGroupKey] = useState(measureGroups[0]?.key ?? "");
  const [isNormalizing, setIsNormalizing] = useState(false);
  const [isExpanding, setIsExpanding] = useState(false);
  const [hasPrepared, setHasPrepared] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"error" | "success">("error");

  useEffect(() => {
    setMeasureField(initialMeasureField);
    setGroupKey(measureGroups[0]?.key ?? "");
    setHasPrepared(false);
    setMessage("");
  }, [importId, sheetName, initialMeasureField, measureGroups]);

  const hasMonthly = monthlyColumns.length > 0;
  const hasAnnual = annualColumns.length > 0;
  const periodKind = hasMonthly && hasAnnual ? "meses ou anos" : hasMonthly ? "meses" : "anos";
  const selectedGroup = measureGroups.find((group) => group.key === groupKey);
  const isBusy = isNormalizing || isExpanding;

  async function expandMeasure() {
    if (!selectedGroup) return;
    setIsExpanding(true);
    setMessage("");
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(importId)}/expand-periods`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sheet_name: sheetName, municipality_field: municipalityField, measure_label: selectedGroup.label, period_fields: selectedGroup.fields }) });
      if (!response.ok) {
        setMessageKind("error");
        setMessage(await importErrorMessage(response, "Não conseguimos criar a aba com todos os períodos."));
        return;
      }
      const payload = await response.json();
      setMessageKind("success");
      setMessage(`Criamos a aba “${payload.sheet_name}” com ${payload.created_rows.toLocaleString("pt-BR")} registros (${payload.periods.toLocaleString("pt-BR")} períodos).${payload.unresolved_rows ? ` ${payload.unresolved_rows.toLocaleString("pt-BR")} registros ficaram sem código IBGE reconhecido e vão aparecer como pendência.` : ""}${payload.empty_cells ? ` ${payload.empty_cells.toLocaleString("pt-BR")} células vazias foram ignoradas.` : ""} Abrindo a nova aba para gravar.`);
      onSheetCreated(payload.sheet_name);
    } catch {
      setMessageKind("error");
      setMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsExpanding(false);
    }
  }

  async function normalizeWideTable() {
    setIsNormalizing(true);
    setMessage("");
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(importId)}/normalize-wide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ municipality_field: municipalityField, value_field: measureField, sheet_name: sheetName }) });
      if (!response.ok) {
        setMessageKind("error");
        setMessage(await importErrorMessage(response, "Não conseguimos preparar os registros desta coluna."));
        return;
      }
      const payload = await response.json();
      onPrepared({ municipality_field: payload.municipality_field, year_field: payload.year_field, value_field: payload.value_field, granularity: payload.granularity });
      setHasPrepared(true);
      setMessageKind("success");
      setMessage(`${payload.transformed_rows.toLocaleString("pt-BR")} registros foram preparados para ${formatPreparedPeriod(payload.reference_period, payload.granularity)}.${payload.skipped_rows ? ` ${payload.skipped_rows.toLocaleString("pt-BR")} linhas sem código IBGE ou valor numérico ficaram fora.` : ""}`);
    } catch {
      setMessageKind("error");
      setMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsNormalizing(false);
    }
  }

  return <section className={styles.processHint}>
    <strong>Planilha com períodos nas colunas</strong>
    <p>Esta fonte organiza {periodKind} em colunas diferentes. O Decsys pode transformar isso em uma linha por município e período, sem alterar a aba original. Os códigos IBGE já confirmados são mantidos.</p>
    {!municipalityField ? <p className={styles.fieldNote}>Antes, escolha no formulário abaixo a coluna com o código IBGE (6 ou 7 dígitos) ou confirme os códigos no quadro de municípios.</p> : null}
    {measureGroups.length ? <>
      <label>Medida para gravar em todos os períodos<select onChange={(event) => setGroupKey(event.target.value)} value={groupKey}>{measureGroups.map((group) => <option key={group.key} value={group.key}>{group.label} — {group.fields.length.toLocaleString("pt-BR")} {group.granularity === "month" ? "meses" : "anos"} ({group.firstPeriod} a {group.lastPeriod})</option>)}</select></label>
      <button disabled={isBusy || !municipalityField || !selectedGroup} onClick={() => void expandMeasure()} type="button">{isExpanding ? "Criando aba..." : `Criar aba com ${selectedGroup?.fields.length.toLocaleString("pt-BR") ?? 0} períodos`}</button>
      {isExpanding ? <StatusNotice variant="loading">Criando uma linha por município e período. Planilhas com muitos municípios podem levar alguns instantes.</StatusNotice> : null}
    </> : null}
    <details className={styles.matchDetails}>
      <summary>{measureGroups.length ? "Ou preparar só uma coluna de período" : "Preparar uma coluna de período"}</summary>
      <label>Coluna do período<select onChange={(event) => setMeasureField(event.target.value)} value={measureField}><option value="">Selecione uma coluna</option>{hasMonthly ? <optgroup label="Mensais">{monthlyColumns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</optgroup> : null}{hasAnnual ? <optgroup label="Anuais">{annualColumns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</optgroup> : null}</select></label>
      {hasPrepared ? <p className={styles.fieldNote}>Os valores desta coluna já foram preparados. No formulário abaixo, o período fica como “preparado a partir das colunas”.</p> : null}
      <button disabled={isBusy || !municipalityField || !measureField} onClick={() => void normalizeWideTable()} type="button">{isNormalizing ? "Transformando..." : "Preparar registros desta coluna"}</button>
    </details>
    {isNormalizing ? <StatusNotice variant="loading">Preparando os valores para revisão.</StatusNotice> : null}
    {message ? <StatusNotice variant={messageKind}>{message}</StatusNotice> : null}
  </section>;
}
