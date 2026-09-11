import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import styles from "../../page.module.css";
import { Indicator, SourceProfile } from "@/lib/types/importacao";

type MunicipalApprovalProps = { importId: string; sourceProfile: SourceProfile };

export function MunicipalApproval({ importId, sourceProfile }: MunicipalApprovalProps) {
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [indicatorId, setIndicatorId] = useState("");
  const [municipalityField, setMunicipalityField] = useState(sourceProfile.suggestions.municipality_code ?? "");
  const [yearField, setYearField] = useState(sourceProfile.suggestions.reference_year ?? "");
  const [valueField, setValueField] = useState(sourceProfile.suggestions.value ?? "");
  const [unit, setUnit] = useState("");
  const [isApproving, setIsApproving] = useState(false);
  const [resultMessage, setResultMessage] = useState("");
  const [approvedRows, setApprovedRows] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/indicators")
      .then((response) => response.json())
      .then((payload: Indicator[]) => {
        if (cancelled || !Array.isArray(payload)) return;
        setIndicators(payload);
        if (payload[0]) {
          setIndicatorId(payload[0].id);
          setUnit(payload[0].unit);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function selectIndicator(event: ChangeEvent<HTMLSelectElement>) {
    const selectedId = event.target.value;
    setIndicatorId(selectedId);
    const selectedIndicator = indicators.find((indicator) => indicator.id === selectedId);
    if (selectedIndicator) setUnit(selectedIndicator.unit);
  }

  async function submitApproval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsApproving(true);
    setResultMessage("");
    try {
      const response = await fetch(`/api/imports/${importId}/approve-municipal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ indicator_id: indicatorId, municipality_field: municipalityField, year_field: yearField, value_field: valueField, unit })
      });
      const payload = await response.json();
      if (!response.ok) setResultMessage(payload.detail ?? payload.message ?? "Não foi possível gravar no painel municipal.");
      else setApprovedRows(payload.approved_rows);
    } catch {
      setResultMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsApproving(false);
    }
  }

  if (approvedRows !== null) {
    return <section className={styles.analysisPanel}>
      <h2>Gravado no painel municipal</h2>
      <p className={styles.profileGuidance}>{approvedRows.toLocaleString("pt-BR")} linhas foram aprovadas e gravadas como observações do indicador selecionado.</p>
    </section>;
  }

  return <section className={styles.analysisPanel}>
    <h2>Gravar no painel municipal</h2>
    <p className={styles.profileGuidance}>Associe as colunas da fonte a um indicador existente. Somente linhas com código IBGE, ano e valor válidos são gravadas — o restante fica registrado como pendência de validação.</p>
    <form className={styles.sourceForm} onSubmit={submitApproval}>
      <label>Indicador
        <select onChange={selectIndicator} required value={indicatorId}>
          <option disabled value="">Selecione um indicador</option>
          {indicators.map((indicator) => <option key={indicator.id} value={indicator.id}>{indicator.name} ({indicator.code})</option>)}
        </select>
      </label>
      <label>Coluna do código IBGE do município<input onChange={(event) => setMunicipalityField(event.target.value)} required value={municipalityField} /></label>
      <label>Coluna do ano<input onChange={(event) => setYearField(event.target.value)} required value={yearField} /></label>
      <label>Coluna do valor<input onChange={(event) => setValueField(event.target.value)} required value={valueField} /></label>
      <label>Unidade<input onChange={(event) => setUnit(event.target.value)} required value={unit} /></label>
      {resultMessage ? <p className={styles.feedbackMessage}>{resultMessage}</p> : null}
      <button className={styles.primaryButton} disabled={isApproving || !indicatorId} type="submit">{isApproving ? "Gravando..." : "Gravar no painel municipal"}</button>
    </form>
  </section>;
}
