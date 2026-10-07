import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "../../page.module.css";
import { Indicator, SourceProfile } from "@/lib/types/importacao";
import { importErrorMessage } from "@/lib/import-error-message";
import { isAnnualPeriodColumn, isMunicipalityColumn, isPeriodColumn, municipalityColumnsFirst, suggestedField, suggestedMunicipalityName, suggestedPeriodColumn } from "@/lib/municipal-columns";
import { effectiveGranularity, frequencyGranularity, isPeriodSelectionComplete, PeriodGranularity, periodRequest, PeriodSelection, suggestedPeriod } from "@/lib/period-selection";
import { expandedSheetGranularity, isExpandedPeriodSheet, periodMeasureGroups } from "@/lib/period-measures";
import { StatusNotice } from "../status-notice";
import { ValidationIssue, ValidationIssueList } from "./lista-pendencias";
import { MunicipalityLookup } from "./localizar-municipios";
import { PeriodColumnsPreparation, PreparedPeriodFields } from "./preparar-mensal";
import { PeriodFields } from "./campos-periodo";

type MunicipalApprovalProps = { importId: string; sourceProfile: SourceProfile; onSheetCreated: (sheetName: string) => void };
type MeasureMapping = { indicatorId: string; valueField: string; numeratorField: string; denominatorField: string; unit: string };
type RowProblem = { row_number: number; value: string };
type IndicatorResult = { indicator_id: string; indicator_name: string; indicator_code: string; approved_rows: number; value_problem_count: number; value_problems: RowProblem[] };
type BatchApprovalSummary = { approved_value_count: number; indicator_results: IndicatorResult[]; period_problem_count: number; period_problems: RowProblem[]; municipality_problem_count: number; municipality_problems: RowProblem[] };
type CalculationPreview = { total_rows: number; valid_rows: number; invalid_rows: number; examples: { row_number: number; municipality: string | null; numerator: string | null; denominator: string | null; calculated_value: number | null; valid: boolean }[] };

const PREPARED_MUNICIPALITY_FIELD = "municipality_ibge_code";
const NOT_MUNICIPAL = "__not_municipal__";
const NEW_INDICATOR = "__new_indicator__";
const MAX_MAPPINGS = 20;

function initialPeriod(sourceProfile: SourceProfile): PeriodSelection {
  const suggestion = suggestedPeriod(sourceProfile);
  return isExpandedPeriodSheet(sourceProfile) ? { ...suggestion, mode: "prepared" } : suggestion;
}

function initialMunicipalityField(sourceProfile: SourceProfile) {
  return isExpandedPeriodSheet(sourceProfile) ? PREPARED_MUNICIPALITY_FIELD : suggestedField(sourceProfile, "municipality_code");
}

function suggestedValueField(sourceProfile: SourceProfile) {
  return isExpandedPeriodSheet(sourceProfile) ? "value" : suggestedField(sourceProfile, "value");
}

function problemSummary(count: number, problems: RowProblem[], description: string) {
  if (!count) return "";
  const examples = problems.slice(0, 3).map((problem) => `linha ${problem.row_number}: “${problem.value || "vazio"}”`).join("; ");
  return `${count.toLocaleString("pt-BR")} linhas ${description}${examples ? ` (ex.: ${examples})` : ""}.`;
}

function useIndicatorCatalog() {
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setMessage("");
    fetch("/api/indicators", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível carregar os indicadores."));
        const payload: unknown = await response.json();
        if (!Array.isArray(payload)) throw new Error("A lista de indicadores veio em um formato inesperado.");
        return payload as Indicator[];
      })
      .then((indicatorList) => { if (!cancelled) setIndicators(indicatorList); })
      .catch((loadError: unknown) => { if (!cancelled) setMessage(loadError instanceof Error ? loadError.message : "Não conseguimos carregar os indicadores."); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { indicators, isLoading, message, retry };
}

export function MunicipalApproval({ importId, sourceProfile, onSheetCreated }: MunicipalApprovalProps) {
  const { indicators, isLoading: isLoadingIndicators, message: indicatorMessage, retry } = useIndicatorCatalog();
  const monthlyColumns = sourceProfile.columns.filter((column) => isPeriodColumn(column.name));
  const annualColumns = sourceProfile.columns.filter((column) => isAnnualPeriodColumn(column.name));
  const measureGroups = useMemo(() => periodMeasureGroups(sourceProfile), [sourceProfile]);
  const isExpandedSheet = isExpandedPeriodSheet(sourceProfile);
  const hasWidePeriodColumns = monthlyColumns.length > 0 || annualColumns.length > 0;
  const orderedColumns = municipalityColumnsFirst(sourceProfile);
  const hasRecognizedMunicipality = sourceProfile.columns.some((column) => isMunicipalityColumn(column.name));
  const [municipalityField, setMunicipalityField] = useState(() => initialMunicipalityField(sourceProfile));
  const [mappings, setMappings] = useState<MeasureMapping[]>([{ indicatorId: "", valueField: suggestedValueField(sourceProfile), numeratorField: "", denominatorField: "", unit: "" }]);
  const [period, setPeriod] = useState(() => initialPeriod(sourceProfile));
  const [preparedGranularity, setPreparedGranularity] = useState<PeriodGranularity | null>(() => isExpandedSheet ? expandedSheetGranularity(sourceProfile) : null);
  const [hasPreparedMunicipalityCode, setHasPreparedMunicipalityCode] = useState(isExpandedSheet);
  const [isWaitingForNewIndicator, setIsWaitingForNewIndicator] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"error" | "warning">("error");
  const [summary, setSummary] = useState<BatchApprovalSummary | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [previews, setPreviews] = useState<(CalculationPreview | null)[]>([null]);
  const [loadingPreviews, setLoadingPreviews] = useState<boolean[]>([false]);
  const mappingsRef = useRef(mappings);
  mappingsRef.current = mappings;

  useEffect(() => {
    setMunicipalityField(initialMunicipalityField(sourceProfile));
    setMappings([{ indicatorId: "", valueField: suggestedValueField(sourceProfile), numeratorField: "", denominatorField: "", unit: "" }]);
    setPreviews([null]);
    setLoadingPreviews([false]);
    setPeriod(initialPeriod(sourceProfile));
    setPreparedGranularity(isExpandedPeriodSheet(sourceProfile) ? expandedSheetGranularity(sourceProfile) : null);
    setHasPreparedMunicipalityCode(isExpandedPeriodSheet(sourceProfile));
    setSummary(null);
    setIssues([]);
    setMessage("");
  }, [importId, sourceProfile]);

  useEffect(() => {
    if (!isWaitingForNewIndicator) return;
    function refreshCatalog() {
      if (document.visibilityState !== "visible") return;
      setIsWaitingForNewIndicator(false);
      retry();
    }
    document.addEventListener("visibilitychange", refreshCatalog);
    return () => document.removeEventListener("visibilitychange", refreshCatalog);
  }, [isWaitingForNewIndicator, retry]);

  const isNotMunicipal = municipalityField === NOT_MUNICIPAL;
  const granularity = effectiveGranularity(period, preparedGranularity);
  const fieldLabels = useMemo(() => {
    const labels: Record<string, string> = { reference_year: "período", [municipalityField]: "município" };
    mappings.forEach((mapping) => {
      const indicator = indicators.find((candidate) => candidate.id === mapping.indicatorId);
      if (indicator) labels[`decsys_value__${indicator.code}`] = `Valor - ${indicator.name}`;
    });
    return labels;
  }, [indicators, mappings, municipalityField]);

  function updateMapping(index: number, field: keyof MeasureMapping, value: string) {
    setMappings((current) => current.map((mapping, mappingIndex) => mappingIndex === index ? { ...mapping, [field]: value } : mapping));
    setPreviews((current) => current.map((preview, previewIndex) => previewIndex === index ? null : preview));
  }

  function selectIndicator(index: number, indicatorId: string) {
    if (indicatorId === NEW_INDICATOR) {
      setIsWaitingForNewIndicator(true);
      window.open("/indicadores/novo", "_blank", "noopener");
      return;
    }
    const indicator = indicators.find((candidate) => candidate.id === indicatorId);
    setMappings((current) => current.map((mapping, mappingIndex) => mappingIndex === index ? { ...mapping, indicatorId, unit: indicator?.unit ?? "" } : mapping));
    setPreviews((current) => current.map((preview, previewIndex) => previewIndex === index ? null : preview));
  }

  function addMapping() {
    if (mappings.length >= MAX_MAPPINGS) return;
    setMappings((current) => [...current, { indicatorId: "", valueField: "", numeratorField: "", denominatorField: "", unit: "" }]);
    setPreviews((current) => [...current, null]);
    setLoadingPreviews((current) => [...current, false]);
  }

  function applyPreparedPeriodColumns(fields: PreparedPeriodFields) {
    setMunicipalityField(fields.municipality_field);
    setPreparedGranularity(fields.granularity);
    setPeriod((current) => ({ ...current, mode: "prepared" }));
    setHasPreparedMunicipalityCode(true);
    setMappings((current) => current.map((mapping) => ({ ...mapping, valueField: fields.value_field, numeratorField: "", denominatorField: "" })));
    setPreviews((current) => current.map(() => null));
  }

  async function loadValidationIssues() {
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(importId)}/validation-issues`, { cache: "no-store" });
      if (!response.ok) return { loaded: false, issues: [] as ValidationIssue[] };
      const payload: unknown = await response.json();
      return { loaded: Array.isArray(payload), issues: Array.isArray(payload) ? payload as ValidationIssue[] : [] };
    } catch {
      return { loaded: false, issues: [] as ValidationIssue[] };
    }
  }

  async function previewMapping(index: number, mapping: MeasureMapping) {
    const indicator = indicators.find((candidate) => candidate.id === mapping.indicatorId);
    if (!indicator) return;
    const requestedFields = JSON.stringify({ indicatorId: mapping.indicatorId, valueField: mapping.valueField, numeratorField: mapping.numeratorField, denominatorField: mapping.denominatorField });
    const isRatio = indicator.calculation_type === "ratio";
    setLoadingPreviews((current) => current.map((loading, currentIndex) => currentIndex === index ? true : loading));
    setPreviews((current) => current.map((preview, currentIndex) => currentIndex === index ? null : preview));
    setMessage("");
    try {
      const calculation = isRatio
        ? { calculation_type: "ratio", numerator_field: mapping.numeratorField, denominator_field: mapping.denominatorField, calculation_multiplier: indicator.calculation_multiplier ?? 1 }
        : { calculation_type: "direct", direct_field: mapping.valueField };
      const response = await fetch(`/api/imports/${encodeURIComponent(importId)}/municipal-preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...calculation, sheet_name: sourceProfile.selected_sheet }) });
      if (!response.ok) throw new Error(await importErrorMessage(response, `Não foi possível conferir ${indicator.name}.`));
      const preview = await response.json() as CalculationPreview;
      const currentMapping = mappingsRef.current[index];
      const currentFields = currentMapping && JSON.stringify({ indicatorId: currentMapping.indicatorId, valueField: currentMapping.valueField, numeratorField: currentMapping.numeratorField, denominatorField: currentMapping.denominatorField });
      if (currentFields === requestedFields) setPreviews((current) => current.map((previous, currentIndex) => currentIndex === index ? preview : previous));
    } catch (previewError) {
      setMessageKind("error");
      setMessage(previewError instanceof Error ? previewError.message : "Não foi possível conferir esta medida.");
    } finally {
      setLoadingPreviews((current) => current.map((loading, currentIndex) => currentIndex === index ? false : loading));
    }
  }

  async function submitApproval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const duplicateIndicators = new Set(mappings.map((mapping) => mapping.indicatorId).filter(Boolean));
    if (duplicateIndicators.size !== mappings.filter((mapping) => mapping.indicatorId).length) {
      setMessage("Cada indicador pode aparecer uma vez nesta gravação. Remova a repetição ou escolha outro indicador.");
      return;
    }
    setIsApproving(true);
    setMessage("");
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(importId)}/approve-municipal-batch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ municipality_field: municipalityField, sheet_name: sourceProfile.selected_sheet, period: periodRequest(period), mappings: mappings.map((mapping) => ({ indicator_id: mapping.indicatorId, value_field: mapping.numeratorField ? undefined : mapping.valueField, numerator_field: mapping.numeratorField || undefined, denominator_field: mapping.numeratorField ? mapping.denominatorField : undefined, unit: mapping.unit })) }) });
      if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível gravar os indicadores. Confira os campos e tente novamente."));
      const payload = await response.json() as BatchApprovalSummary;
      const issueResult = await loadValidationIssues();
      setIssues(issueResult.issues);
      setSummary(payload);
      const preparationNotes = [problemSummary(payload.municipality_problem_count, payload.municipality_problems, "sem código IBGE reconhecido"), problemSummary(payload.period_problem_count, payload.period_problems, "sem período reconhecido")].filter(Boolean).join(" ");
      const allRowsRejected = payload.indicator_results.every((result) => result.approved_rows === 0);
      setMessageKind(allRowsRejected ? "error" : "warning");
      setMessage([preparationNotes, issueResult.loaded ? "" : "A gravação terminou, mas não foi possível carregar a lista de pendências."] .filter(Boolean).join(" "));
    } catch (submitError) {
      setMessageKind("error");
      setMessage(submitError instanceof Error ? submitError.message : "Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsApproving(false);
    }
  }

  if (summary) return <section className={styles.analysisPanel}>
    <h2>Resultado da gravação</h2>
    <div className={styles.batchResultGrid}>{summary.indicator_results.map((result) => <div className={styles.batchResult} key={result.indicator_id}><strong>{result.indicator_name}</strong><span>{result.approved_rows.toLocaleString("pt-BR")} municípios gravados</span>{result.value_problem_count ? <span>{result.value_problem_count.toLocaleString("pt-BR")} valores precisam de revisão</span> : null}</div>)}</div>
    {message ? <StatusNotice variant={messageKind}>{message}</StatusNotice> : null}
    <ValidationIssueList fieldLabels={fieldLabels} issues={issues} />
    <div className={styles.completionActions}><Link className={styles.primaryLink} href="/dados-revisados">Ver dados revisados</Link><Link className={styles.secondaryLink} href="/importar">Nova importação</Link><Link className={styles.secondaryLink} href="/importacoes">Importações salvas</Link></div>
  </section>;

  if (isLoadingIndicators) return <section className={styles.analysisPanel}><StatusNotice variant="loading">Carregando os indicadores cadastrados.</StatusNotice></section>;
  if (indicatorMessage) return <section className={styles.analysisPanel}><StatusNotice action={{ label: "Tentar novamente", onClick: retry }} variant="error">{indicatorMessage}</StatusNotice></section>;
  if (!indicators.length) return <section className={styles.analysisPanel}><h2>Gravar no painel municipal</h2><StatusNotice title="Ainda não há indicadores cadastrados" variant="info">Cadastre os indicadores que descrevem as medidas da planilha. Depois volte para esta importação. Você também pode manter a fonte salva para revisão ou exportá-la.</StatusNotice><Link className={styles.primaryLink} href="/indicadores/novo" target="_blank" onClick={() => setIsWaitingForNewIndicator(true)}>Cadastrar indicador</Link></section>;

  return <section className={styles.analysisPanel}>
    <h2>Gravar no painel municipal</h2>
    <p className={styles.profileGuidance}>Associe cada medida da planilha a um indicador. Município e período são escolhidos uma vez; todas as medidas serão gravadas juntas na mesma importação.</p>
    {!hasRecognizedMunicipality ? <StatusNotice title="Não reconhecemos a coluna de município" variant="info">Escolha manualmente a coluna com o município ou código IBGE. Sem esse campo, a aba pode continuar salva ou ser exportada, mas não entra no painel municipal.</StatusNotice> : null}
    {isExpandedSheet ? <StatusNotice title="Aba criada pelo Decsys" variant="info">Esta aba já tem município, período e valor preparados. Se precisar mapear várias medidas, volte à aba original que contém as colunas de cada medida.</StatusNotice> : null}
    {!isNotMunicipal ? <div className={styles.municipalPreparation}><MunicipalityLookup columns={orderedColumns} importId={importId} initialField={suggestedMunicipalityName(sourceProfile)} onPrepared={(field) => { setMunicipalityField(field); setHasPreparedMunicipalityCode(true); }} sheetName={sourceProfile.selected_sheet} />{!isExpandedSheet && (monthlyColumns.length || annualColumns.length) ? <PeriodColumnsPreparation annualColumns={annualColumns} importId={importId} initialMeasureField={suggestedPeriodColumn(sourceProfile, sourceProfile.indicator_recommendations?.[0]?.value_field)} measureGroups={measureGroups} monthlyColumns={monthlyColumns} municipalityField={municipalityField === NOT_MUNICIPAL ? "" : municipalityField} onPrepared={applyPreparedPeriodColumns} onSheetCreated={onSheetCreated} sheetName={sourceProfile.selected_sheet} /> : null}</div> : null}
    {sourceProfile.indicator_recommendations?.length ? <div className={styles.indicatorRecommendations}><p className={styles.fieldNote}>Sugestões automáticas pelo conteúdo da planilha. Confira se cada sugestão representa a mesma informação que o indicador.</p>{sourceProfile.indicator_recommendations.map((recommendation) => <div className={styles.indicatorRecommendation} key={recommendation.code}><div><strong>{recommendation.name}</strong><p>{recommendation.unit} · coluna sugerida: {recommendation.value_field}</p></div></div>)}</div> : null}
    <form className={`${styles.sourceForm} ${styles.municipalMappingGrid}`} onSubmit={submitApproval}>
      <label>Qual coluna identifica o município?<select onChange={(event) => setMunicipalityField(event.target.value)} required value={municipalityField}><option disabled value="">Selecione uma coluna</option>{hasPreparedMunicipalityCode ? <option value={PREPARED_MUNICIPALITY_FIELD}>Código IBGE preparado pelo Decsys</option> : null}{orderedColumns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}<option value={NOT_MUNICIPAL}>A planilha não é por município</option></select><span className={styles.fieldNote}>Códigos de 6 dígitos são convertidos automaticamente. Para nomes de municípios, use a busca de correspondências acima.</span></label>
      {isNotMunicipal ? <StatusNotice title="Este painel exige um município por linha" variant="warning">Dados por UF, região, bairro ou país podem ser exportados ou mantidos para revisão, mas não entram no painel municipal.</StatusNotice> : <>
        <PeriodFields columns={sourceProfile.columns} hasPreparedPeriod={preparedGranularity !== null} onChange={(selection) => { setPeriod(selection); setPreviews((current) => current.map(() => null)); }} preparedGranularity={preparedGranularity} selection={period} />
        <div className={styles.measureMappingList}>{mappings.map((mapping, index) => {
          const indicator = indicators.find((candidate) => candidate.id === mapping.indicatorId);
          const isRatio = indicator?.calculation_type === "ratio";
          const indicatorGranularity = frequencyGranularity(indicator?.expected_frequency);
          const requiredFieldsPresent = isRatio ? Boolean(mapping.numeratorField && mapping.denominatorField && mapping.numeratorField !== mapping.denominatorField) : Boolean(mapping.valueField);
          return <fieldset className={styles.measureMapping} key={index}><legend>Medida {index + 1}</legend><label>Indicador<select onChange={(event) => selectIndicator(index, event.target.value)} required value={mapping.indicatorId}><option disabled value="">Selecione o indicador</option>{indicators.map((candidate) => <option disabled={mappings.some((other, otherIndex) => otherIndex !== index && other.indicatorId === candidate.id)} key={candidate.id} value={candidate.id}>{candidate.name} ({candidate.code})</option>)}<option value={NEW_INDICATOR}>Cadastrar um novo indicador</option></select></label>{isRatio ? <><label>Numerador<select onChange={(event) => updateMapping(index, "numeratorField", event.target.value)} required value={mapping.numeratorField}><option value="">Selecione uma coluna</option>{sourceProfile.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label><label>Denominador<select onChange={(event) => updateMapping(index, "denominatorField", event.target.value)} required value={mapping.denominatorField}><option value="">Selecione uma coluna</option>{sourceProfile.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select><span className={styles.fieldNote}>O sistema calcula numerador ÷ denominador × {indicator?.calculation_multiplier ?? 1}. Denominadores vazios ou iguais a zero viram pendência.</span></label></> : <label>Coluna com o valor<select onChange={(event) => updateMapping(index, "valueField", event.target.value)} required value={mapping.valueField}><option value="">Selecione uma coluna</option>{preparedGranularity ? <option value="value">Valor preparado pelo Decsys</option> : null}{sourceProfile.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select><span className={styles.fieldNote}>Aceita números no formato brasileiro, como 1.234,5.</span></label>}<label>Unidade do valor<input onChange={(event) => updateMapping(index, "unit", event.target.value)} required value={mapping.unit} /><span className={styles.fieldNote}>Confira na fonte: pessoas, %, reais, casos por 100 mil habitantes.</span></label>{indicator && indicatorGranularity && indicatorGranularity !== granularity ? <StatusNotice title="Confira a periodicidade" variant="warning">O indicador é {indicatorGranularity === "month" ? "mensal" : "anual"}, mas a seleção atual é {granularity === "month" ? "mensal" : "anual"}.</StatusNotice> : null}{requiredFieldsPresent && indicator ? <><button className={styles.secondaryLink} disabled={loadingPreviews[index]} onClick={() => void previewMapping(index, mapping)} type="button">{loadingPreviews[index] ? "Conferindo valores..." : "Conferir esta medida"}</button>{loadingPreviews[index] ? <StatusNotice variant="loading">Analisando os valores desta coluna.</StatusNotice> : null}{previews[index] ? <div className={styles.calculationPreview}><div><strong>{previews[index]?.valid_rows.toLocaleString("pt-BR")}</strong><span>valores válidos</span><strong>{previews[index]?.invalid_rows.toLocaleString("pt-BR")}</strong><span>valores para revisar</span></div><p>{previews[index]?.total_rows.toLocaleString("pt-BR")} linhas conferidas. A prévia não grava os dados.</p></div> : <span className={styles.fieldNote}>Confira os valores antes de gravar. É possível continuar sem excluir as linhas pendentes.</span>}</> : <span className={styles.fieldNote}>Escolha a coluna ou as colunas que formam esta medida.</span>}<button className={styles.removeMeasureButton} disabled={mappings.length === 1 || loadingPreviews.some(Boolean)} onClick={() => { setMappings((current) => current.filter((_, mappingIndex) => mappingIndex !== index)); setPreviews((current) => current.filter((_, previewIndex) => previewIndex !== index)); setLoadingPreviews((current) => current.filter((_, loadingIndex) => loadingIndex !== index)); }} type="button">Remover medida</button></fieldset>;
        })}</div>
        {!isExpandedSheet && !hasWidePeriodColumns ? <button className={styles.secondaryLink} disabled={mappings.length >= MAX_MAPPINGS || loadingPreviews.some(Boolean)} onClick={addMapping} type="button">+ Adicionar outra medida</button> : null}
        <p className={styles.fieldNote}>O mesmo arquivo não será reenviado. Cada medida vira um indicador separado, mas mantém vínculo com esta importação e com sua fonte.</p>
        {hasWidePeriodColumns && !isExpandedSheet ? <StatusNotice title="Esta planilha tem períodos em várias colunas" variant="info">Prepare um grupo de medida por vez no quadro acima antes de gravar. A associação de vários grupos de meses ou anos numa só confirmação ainda não está disponível.</StatusNotice> : null}
        {isExpandedSheet ? <StatusNotice title="Esta aba contém uma medida preparada" variant="info">Para gravar outras medidas da planilha, volte à aba original e prepare cada grupo de períodos. O vínculo de vários grupos numa única confirmação será uma próxima melhoria; esta aba só pode ser associada ao indicador da medida que ela contém.</StatusNotice> : null}
      </>}
      {isWaitingForNewIndicator ? <StatusNotice variant="info">Cadastre o indicador na nova aba e volte aqui. A lista será recarregada.</StatusNotice> : null}
      {message ? <StatusNotice variant={messageKind}>{message}</StatusNotice> : null}
      <button className={`${styles.primaryButton} ${styles.mappingSubmit}`} disabled={isApproving || loadingPreviews.some(Boolean) || isNotMunicipal || mappings.some((mapping, index) => !mapping.indicatorId || !mapping.unit.trim() || !previews[index]?.valid_rows || (indicators.find((indicator) => indicator.id === mapping.indicatorId)?.calculation_type === "ratio" ? !mapping.numeratorField || !mapping.denominatorField || mapping.numeratorField === mapping.denominatorField : !mapping.valueField)) || !municipalityField || !isPeriodSelectionComplete(period)} type="submit">{isApproving ? "Validando e gravando medidas..." : `Validar e gravar ${mappings.length} ${mappings.length === 1 ? "indicador" : "indicadores"}`}</button>
      {isApproving ? <StatusNotice variant="loading">Estamos conferindo município, período e valores de cada medida. O painel só recebe linhas que passam pela validação.</StatusNotice> : null}
    </form>
  </section>;
}
