import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import styles from "../../page.module.css";
import { Indicator, IndicatorRecommendation, SourceProfile } from "@/lib/types/importacao";

type MunicipalApprovalProps = { importId: string; sourceProfile: SourceProfile };
type IndicatorRegistration = { code: string; name: string; dimension: string; definition: string; unit: string; expected_frequency: string };

function registrationFromRecommendation(recommendation?: IndicatorRecommendation): IndicatorRegistration {
  return { code: recommendation?.code ?? "", name: recommendation?.name ?? "", dimension: recommendation?.dimension ?? "", definition: recommendation?.definition ?? "", unit: recommendation?.unit ?? "", expected_frequency: recommendation?.expected_frequency ?? "" };
}

export function MunicipalApproval({ importId, sourceProfile }: MunicipalApprovalProps) {
  const recommendedIndicator = sourceProfile.indicator_recommendations?.[0];
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [indicatorId, setIndicatorId] = useState("");
  const [municipalityField, setMunicipalityField] = useState(sourceProfile.suggestions.municipality_code ?? "");
  const [yearField, setYearField] = useState(sourceProfile.suggestions.reference_year ?? "");
  const [valueField, setValueField] = useState(sourceProfile.suggestions.value ?? recommendedIndicator?.value_field ?? "");
  const [unit, setUnit] = useState("");
  const [isApproving, setIsApproving] = useState(false);
  const [resultMessage, setResultMessage] = useState("");
  const [approvedRows, setApprovedRows] = useState<number | null>(null);
  const [showRegistration, setShowRegistration] = useState(false);
  const [registration, setRegistration] = useState<IndicatorRegistration>(() => registrationFromRecommendation(recommendedIndicator));
  const [isRegistering, setIsRegistering] = useState(false);
  const [registrationMessage, setRegistrationMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/indicators")
      .then((response) => response.json())
      .then((payload: Indicator[]) => {
        if (cancelled || !Array.isArray(payload)) return;
        setIndicators(payload);
        setShowRegistration(payload.length === 0);
        if (payload[0]) {
          setIndicatorId(payload[0].id);
          setUnit(payload[0].unit);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function selectIndicator(event: ChangeEvent<HTMLSelectElement>) {
    const selectedId = event.target.value;
    setIndicatorId(selectedId);
    const selectedIndicator = indicators.find((indicator) => indicator.id === selectedId);
    if (selectedIndicator) setUnit(selectedIndicator.unit);
  }

  function updateRegistration(fieldName: keyof IndicatorRegistration, fieldValue: string) {
    setRegistration((currentRegistration) => ({ ...currentRegistration, [fieldName]: fieldValue }));
  }

  function useRecommendation() {
    setRegistration(registrationFromRecommendation(recommendedIndicator));
    if (recommendedIndicator) setValueField(recommendedIndicator.value_field);
    setShowRegistration(true);
    setRegistrationMessage("");
  }

  async function registerIndicator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsRegistering(true);
    setRegistrationMessage("");
    try {
      const response = await fetch("/api/indicators", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(registration) });
      const payload = await response.json();
      if (!response.ok) setRegistrationMessage(payload.detail ?? payload.message ?? "Não foi possível cadastrar o indicador.");
      else {
        const createdIndicator = payload as Indicator;
        setIndicators((currentIndicators) => [...currentIndicators, createdIndicator].sort((firstIndicator, secondIndicator) => firstIndicator.name.localeCompare(secondIndicator.name)));
        setIndicatorId(createdIndicator.id);
        setUnit(createdIndicator.unit);
        setShowRegistration(false);
        setRegistrationMessage("Indicador cadastrado e selecionado para esta importação.");
      }
    } catch {
      setRegistrationMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsRegistering(false);
    }
  }

  async function submitApproval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsApproving(true);
    setResultMessage("");
    try {
      const response = await fetch(`/api/imports/${importId}/approve-municipal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ indicator_id: indicatorId, municipality_field: municipalityField, year_field: yearField, value_field: valueField, unit }) });
      const payload = await response.json();
      if (!response.ok) setResultMessage(payload.detail ?? payload.message ?? "Não foi possível gravar no painel municipal.");
      else setApprovedRows(payload.approved_rows);
    } catch {
      setResultMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsApproving(false);
    }
  }

  if (approvedRows !== null) return <section className={styles.analysisPanel}><h2>Gravado no painel municipal</h2><p className={styles.profileGuidance}>{approvedRows.toLocaleString("pt-BR")} linhas foram aprovadas e gravadas como observações do indicador selecionado.</p></section>;

  return <section className={styles.analysisPanel}>
    <h2>Gravar no painel municipal</h2>
    <p className={styles.profileGuidance}>Cadastre o indicador se ele ainda não existir. Depois associe as colunas da fonte e grave apenas dados municipais já revisados.</p>
    {recommendedIndicator ? <div className={styles.indicatorRecommendation}><div><strong>Sugestão automática</strong><p>{recommendedIndicator.name} · {recommendedIndicator.unit} · campo {recommendedIndicator.value_field}</p></div><button onClick={useRecommendation} type="button">Usar como base</button></div> : null}
    {registrationMessage ? <p className={styles.profileGuidance}>{registrationMessage}</p> : null}
    {showRegistration ? <form className={styles.sourceForm} onSubmit={registerIndicator}>
      <h3>Cadastrar indicador</h3>
      <label>Nome<input onChange={(event) => updateRegistration("name", event.target.value)} required value={registration.name} /></label>
      <label>Código interno<input onChange={(event) => updateRegistration("code", event.target.value)} required value={registration.code} /></label>
      <label>Dimensão<input onChange={(event) => updateRegistration("dimension", event.target.value)} placeholder="Ex.: trabalho, energia, mobilidade" required value={registration.dimension} /></label>
      <label>Definição<input onChange={(event) => updateRegistration("definition", event.target.value)} required value={registration.definition} /></label>
      <label>Unidade<input onChange={(event) => updateRegistration("unit", event.target.value)} placeholder="Ex.: pessoas, %, kW" required value={registration.unit} /></label>
      <label>Periodicidade<input onChange={(event) => updateRegistration("expected_frequency", event.target.value)} placeholder="Ex.: mensal ou anual" value={registration.expected_frequency} /></label>
      {registrationMessage ? <p className={styles.feedbackMessage}>{registrationMessage}</p> : null}
      <button className={styles.primaryButton} disabled={isRegistering} type="submit">{isRegistering ? "Cadastrando..." : "Cadastrar indicador"}</button>
    </form> : <button onClick={() => setShowRegistration(true)} type="button">Cadastrar outro indicador</button>}
    {indicators.length ? <form className={styles.sourceForm} onSubmit={submitApproval}>
      <label>Indicador<select onChange={selectIndicator} required value={indicatorId}><option disabled value="">Selecione um indicador</option>{indicators.map((indicator) => <option key={indicator.id} value={indicator.id}>{indicator.name} ({indicator.code})</option>)}</select></label>
      <label>Coluna do código IBGE do município<input onChange={(event) => setMunicipalityField(event.target.value)} required value={municipalityField} /></label>
      <label>Coluna do ano<input onChange={(event) => setYearField(event.target.value)} required value={yearField} /></label>
      <label>Coluna do valor<input onChange={(event) => setValueField(event.target.value)} required value={valueField} /></label>
      <label>Unidade<input onChange={(event) => setUnit(event.target.value)} required value={unit} /></label>
      {resultMessage ? <p className={styles.feedbackMessage}>{resultMessage}</p> : null}
      <button className={styles.primaryButton} disabled={isApproving || !indicatorId} type="submit">{isApproving ? "Gravando..." : "Gravar no painel municipal"}</button>
    </form> : <p className={styles.profileGuidance}>Cadastre o primeiro indicador para liberar a gravação municipal.</p>}
  </section>;
}
