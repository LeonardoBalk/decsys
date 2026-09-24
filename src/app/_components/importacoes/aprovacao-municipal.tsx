import Link from "next/link";
import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "../../page.module.css";
import { Indicator, SourceProfile } from "@/lib/types/importacao";
import { importErrorMessage } from "@/lib/import-error-message";
import { isAnnualPeriodColumn, isMunicipalityColumn, isPeriodColumn, municipalityColumnsFirst, normalizedColumnName, suggestedField, suggestedMunicipalityName, suggestedPeriodColumn } from "@/lib/municipal-columns";
import { effectiveGranularity, frequencyGranularity, isPeriodSelectionComplete, PeriodGranularity, periodRequest, PeriodSelection, suggestedPeriod } from "@/lib/period-selection";
import { expandedSheetGranularity, isExpandedPeriodSheet, periodMeasureGroups } from "@/lib/period-measures";
import { StatusNotice } from "../status-notice";
import { ValidationIssue, ValidationIssueList } from "./lista-pendencias";
import { MunicipalityLookup } from "./localizar-municipios";
import { PeriodColumnsPreparation, PreparedPeriodFields } from "./preparar-mensal";
import { PeriodFields } from "./campos-periodo";

type MunicipalApprovalProps = { importId: string; sourceProfile: SourceProfile; onSheetCreated: (sheetName: string) => void };
type ColumnMapping = { municipalityField: string; valueField: string };
type RowProblem = { row_number: number; value: string };
type ApprovalSummary = { approved_rows: number; period_problem_count: number; period_problems: RowProblem[]; value_problem_count: number; value_problems: RowProblem[]; municipality_problem_count?: number; municipality_problems?: RowProblem[] };

const PREPARED_MUNICIPALITY_FIELD = "municipality_ibge_code";
const NOT_MUNICIPAL = "__not_municipal__";
const NEW_INDICATOR = "__new_indicator__";

function suggestedMapping(sourceProfile: SourceProfile): ColumnMapping {
  if (isExpandedPeriodSheet(sourceProfile)) return { municipalityField: PREPARED_MUNICIPALITY_FIELD, valueField: "value" };
  return { municipalityField: suggestedField(sourceProfile, "municipality_code"), valueField: suggestedField(sourceProfile, "value") };
}

function initialPeriod(sourceProfile: SourceProfile): PeriodSelection {
  const suggestion = suggestedPeriod(sourceProfile);
  return isExpandedPeriodSheet(sourceProfile) ? { ...suggestion, mode: "prepared" } : suggestion;
}

function initialPreparedGranularity(sourceProfile: SourceProfile): PeriodGranularity | null {
  return isExpandedPeriodSheet(sourceProfile) ? expandedSheetGranularity(sourceProfile) : null;
}

function sameUnit(first: string, second: string) {
  return normalizedColumnName(first).replace(/\s+/g, "") === normalizedColumnName(second).replace(/\s+/g, "");
}

function problemSummary(count: number, problems: RowProblem[], description: string) {
  if (!count) return "";
  const examples = problems.slice(0, 3).map((problem) => `linha ${problem.row_number}: “${problem.value || "vazio"}”`).join("; ");
  return `${count.toLocaleString("pt-BR")} linhas ${description}${examples ? ` (ex.: ${examples})` : ""}.`;
}

function useIndicatorCatalog() {
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadMessage, setLoadMessage] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadMessage("");
    fetch("/api/indicators", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível carregar a lista de indicadores."));
        const payload: unknown = await response.json();
        if (!Array.isArray(payload)) throw new Error("A lista de indicadores veio em um formato inesperado. Tente carregar novamente.");
        return payload as Indicator[];
      })
      .then((indicatorList) => { if (!cancelled) setIndicators(indicatorList); })
      .catch((loadError: unknown) => { if (!cancelled) setLoadMessage(loadError instanceof Error ? loadError.message : "Não conseguimos carregar os indicadores. Tente novamente."); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [loadAttempt]);

  const retry = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);
  return { indicators, isLoading, loadMessage, retry };
}

export function MunicipalApproval({ importId, sourceProfile, onSheetCreated }: MunicipalApprovalProps) {
  const recommendedIndicator = sourceProfile.indicator_recommendations?.[0];
  const monthlyColumns = sourceProfile.columns.filter((column) => isPeriodColumn(column.name));
  const annualColumns = sourceProfile.columns.filter((column) => isAnnualPeriodColumn(column.name));
  const measureGroups = useMemo(() => periodMeasureGroups(sourceProfile), [sourceProfile]);
  const isExpandedSheet = isExpandedPeriodSheet(sourceProfile);
  const orderedColumns = municipalityColumnsFirst(sourceProfile);
  const hasRecognizedMunicipality = sourceProfile.columns.some((column) => isMunicipalityColumn(column.name));
  const { indicators, isLoading: isLoadingIndicators, loadMessage: indicatorLoadMessage, retry: retryIndicators } = useIndicatorCatalog();
  const [isWaitingForNewIndicator, setIsWaitingForNewIndicator] = useState(false);
  const [indicatorId, setIndicatorId] = useState("");
  const [unit, setUnit] = useState("");
  const [mapping, setMapping] = useState<ColumnMapping>(() => suggestedMapping(sourceProfile));
  const [period, setPeriod] = useState<PeriodSelection>(() => initialPeriod(sourceProfile));
  const [preparedGranularity, setPreparedGranularity] = useState<PeriodGranularity | null>(() => initialPreparedGranularity(sourceProfile));
  const [hasPreparedMunicipalityCode, setHasPreparedMunicipalityCode] = useState(() => isExpandedPeriodSheet(sourceProfile));
  const [isApproving, setIsApproving] = useState(false);
  const [resultMessage, setResultMessage] = useState("");
  const [resultMessageKind, setResultMessageKind] = useState<"error" | "success">("error");
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([]);
  const [approvalSummary, setApprovalSummary] = useState<ApprovalSummary | null>(null);

  useEffect(() => {
    setIndicatorId("");
    setUnit("");
    setMapping(suggestedMapping(sourceProfile));
    setPeriod(initialPeriod(sourceProfile));
    setPreparedGranularity(initialPreparedGranularity(sourceProfile));
    setHasPreparedMunicipalityCode(isExpandedPeriodSheet(sourceProfile));
    setValidationIssues([]);
    setResultMessage("");
    setApprovalSummary(null);
  }, [importId, sourceProfile]);

  useEffect(() => {
    if (!isWaitingForNewIndicator) return;
    function reloadAfterNewIndicator() {
      if (document.visibilityState !== "visible") return;
      setIsWaitingForNewIndicator(false);
      retryIndicators();
    }
    document.addEventListener("visibilitychange", reloadAfterNewIndicator);
    return () => document.removeEventListener("visibilitychange", reloadAfterNewIndicator);
  }, [isWaitingForNewIndicator, retryIndicators]);

  const selectedIndicator = indicators.find((indicator) => indicator.id === indicatorId);
  const isNotMunicipal = mapping.municipalityField === NOT_MUNICIPAL;
  const granularity = effectiveGranularity(period, preparedGranularity);
  const indicatorGranularity = frequencyGranularity(selectedIndicator?.expected_frequency);
  const fieldLabels: Record<string, string> = { reference_year: "período", value: `valor (${mapping.valueField || "coluna escolhida"})`, [mapping.municipalityField]: "município" };

  function updateMapping(fieldName: keyof ColumnMapping, fieldValue: string) {
    setMapping((currentMapping) => ({ ...currentMapping, [fieldName]: fieldValue }));
  }

  function selectIndicator(event: ChangeEvent<HTMLSelectElement>) {
    const selectedId = event.target.value;
    if (selectedId === NEW_INDICATOR) {
      setIsWaitingForNewIndicator(true);
      window.open("/indicadores/novo", "_blank", "noopener");
      return;
    }
    setIndicatorId(selectedId);
    const chosenIndicator = indicators.find((indicator) => indicator.id === selectedId);
    if (!chosenIndicator) return;
    setUnit(chosenIndicator.unit);
    const chosenGranularity = frequencyGranularity(chosenIndicator.expected_frequency);
    if (chosenGranularity && (period.mode === "date_column" || period.mode === "fixed")) setPeriod((currentPeriod) => ({ ...currentPeriod, granularity: chosenGranularity }));
  }

  function applyPreparedMunicipalityCodes(municipalityField: string) {
    updateMapping("municipalityField", municipalityField);
    setHasPreparedMunicipalityCode(true);
  }

  function applyPreparedPeriodColumns(fields: PreparedPeriodFields) {
    setMapping({ municipalityField: fields.municipality_field, valueField: fields.value_field });
    setHasPreparedMunicipalityCode(true);
    setPreparedGranularity(fields.granularity);
    setPeriod((currentPeriod) => ({ ...currentPeriod, mode: "prepared" }));
  }

  async function loadValidationIssues() {
    const issuesResponse = await fetch(`/api/imports/${encodeURIComponent(importId)}/validation-issues`, { cache: "no-store" });
    if (!issuesResponse.ok) return { issues: [] as ValidationIssue[], error: await importErrorMessage(issuesResponse, "A verificação terminou, mas não conseguimos mostrar as linhas pendentes.") };
    const issuesPayload: unknown = await issuesResponse.json();
    if (!Array.isArray(issuesPayload)) return { issues: [] as ValidationIssue[], error: "Os dados foram verificados, mas a lista de pendências veio em um formato inesperado. Atualize a página para tentar carregar novamente." };
    return { issues: issuesPayload as ValidationIssue[], error: "" };
  }

  async function submitApproval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsApproving(true);
    setResultMessage("");
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(importId)}/approve-municipal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ indicator_id: indicatorId, municipality_field: mapping.municipalityField, value_field: mapping.valueField, unit, sheet_name: sourceProfile.selected_sheet, period: periodRequest(period) }) });
      if (!response.ok) {
        setResultMessageKind("error");
        setResultMessage(await importErrorMessage(response, "Não foi possível gravar os dados. Confira os campos escolhidos e tente novamente."));
        return;
      }
      const payload: ApprovalSummary = await response.json();
      const { issues, error } = await loadValidationIssues();
      setValidationIssues(issues);
      const preparationNotes = [problemSummary(payload.municipality_problem_count ?? 0, payload.municipality_problems ?? [], "sem código IBGE reconhecido (use o quadro de municípios para nomes)"), problemSummary(payload.period_problem_count, payload.period_problems, "sem período reconhecido"), problemSummary(payload.value_problem_count, payload.value_problems, "com valor que não é número")].filter(Boolean).join(" ");
      if (payload.approved_rows > 0) {
        setApprovalSummary(payload);
        setResultMessageKind("error");
        setResultMessage([error, preparationNotes].filter(Boolean).join(" "));
      } else {
        setResultMessageKind("error");
        setResultMessage(error || `Nenhuma linha foi gravada. ${preparationNotes || "Veja as pendências, corrija a origem ou as colunas escolhidas e tente novamente."}`);
      }
    } catch {
      setResultMessageKind("error");
      setResultMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsApproving(false);
    }
  }

  if (approvalSummary) return <section className={styles.analysisPanel}>
    <h2>Dados gravados no painel municipal</h2>
    <StatusNotice variant="success" title={`${approvalSummary.approved_rows.toLocaleString("pt-BR")} linhas válidas gravadas.`}>{validationIssues.length ? `${validationIssues.length.toLocaleString("pt-BR")} pendências impediram outras linhas de entrar na gravação.` : "Todas as linhas selecionadas passaram pela validação."}</StatusNotice>
    {resultMessage ? <StatusNotice variant="warning">{resultMessage}</StatusNotice> : null}
    <ValidationIssueList fieldLabels={fieldLabels} issues={validationIssues} />
    <div className={styles.completionActions}>
      <Link className={styles.primaryLink} href="/dados-revisados">Ver dados revisados</Link>
      <Link className={styles.secondaryLink} href="/">Nova importação</Link>
      <Link className={styles.secondaryLink} href="/importacoes">Importações salvas</Link>
      <button onClick={() => { setApprovalSummary(null); setResultMessage(""); }} type="button">Gravar outro indicador desta aba</button>
    </div>
  </section>;

  const canSubmit = !isApproving && Boolean(indicatorId) && !isNotMunicipal && Boolean(mapping.municipalityField) && Boolean(mapping.valueField) && Boolean(unit.trim()) && isPeriodSelectionComplete(period);

  return <section className={styles.analysisPanel}>
    <h2>Gravar no painel municipal</h2>
    <p className={styles.profileGuidance}>Associe as colunas a um indicador já cadastrado. O catálogo de indicadores fica em uma área própria para não misturar cadastro com importação.</p>
    {!hasRecognizedMunicipality ? <StatusNotice variant="info" title="Não reconhecemos a coluna de município">Nenhum título de coluna parece indicar município ou código IBGE. Se a aba tiver essa informação com outro nome, escolha a coluna manualmente abaixo. Se a planilha não for por município, marque essa opção no formulário.</StatusNotice> : null}
    {isExpandedSheet ? <StatusNotice variant="info" title="Aba criada pelo Decsys">Cada linha desta aba é um município em um período, gerada a partir das colunas de período da aba original. Município, período e valor já estão preparados; escolha o indicador e confira a unidade.</StatusNotice> : null}
    {!isNotMunicipal ? <div className={styles.municipalPreparation}>
      <MunicipalityLookup columns={orderedColumns} importId={importId} initialField={suggestedMunicipalityName(sourceProfile)} onPrepared={applyPreparedMunicipalityCodes} sheetName={sourceProfile.selected_sheet} />
      {!isExpandedSheet && (monthlyColumns.length || annualColumns.length) ? <PeriodColumnsPreparation annualColumns={annualColumns} importId={importId} initialMeasureField={suggestedPeriodColumn(sourceProfile, recommendedIndicator?.value_field)} measureGroups={measureGroups} monthlyColumns={monthlyColumns} municipalityField={mapping.municipalityField === NOT_MUNICIPAL ? "" : mapping.municipalityField} onPrepared={applyPreparedPeriodColumns} onSheetCreated={onSheetCreated} sheetName={sourceProfile.selected_sheet} /> : null}
    </div> : null}
    {sourceProfile.indicator_recommendations?.length ? <div className={styles.indicatorRecommendations}><p className={styles.fieldNote}>Sugestões automáticas pelo conteúdo da planilha. Confira se o indicador representa a mesma informação antes de continuar.</p>{sourceProfile.indicator_recommendations.map((recommendation) => <div className={styles.indicatorRecommendation} key={recommendation.code}><div><strong>{recommendation.name}</strong><p>{recommendation.unit} · coluna sugerida: {recommendation.value_field}</p></div></div>)}</div> : null}
    {isLoadingIndicators ? <StatusNotice variant="loading">Carregando os indicadores cadastrados.</StatusNotice> : null}
    {indicatorLoadMessage ? <StatusNotice action={{ label: "Tentar novamente", onClick: retryIndicators }} variant="error">{indicatorLoadMessage}</StatusNotice> : null}
    {!isLoadingIndicators && !indicatorLoadMessage && indicators.length === 0 ? <section className={styles.processHint}><strong>Ainda não há indicadores cadastrados</strong><p>Para enviar dados ao painel municipal, primeiro cadastre o indicador que descreve o que esta planilha mede. Você pode continuar exportando os dados sem fazer esse cadastro.</p><Link className={styles.sourceLink} href="/indicadores/novo" onClick={() => setIsWaitingForNewIndicator(true)} target="_blank">Cadastrar primeiro indicador</Link></section> : null}
    {!isLoadingIndicators && !indicatorLoadMessage && indicators.length > 0 ? <>
      <Link className={styles.sourceLink} href="/indicadores">Ver e organizar indicadores</Link>
      <p className={styles.fieldNote}>Associe cada campo da planilha ao dado correspondente. As linhas com município, período ou valor inválidos ficam fora da gravação e aparecem abaixo para revisão.</p>
      <form className={`${styles.sourceForm} ${styles.municipalMappingGrid}`} onSubmit={submitApproval}>
        <label>O que esta planilha mede?<select onChange={selectIndicator} required value={indicatorId}><option disabled value="">Selecione um indicador</option>{indicators.map((indicator) => <option key={indicator.id} value={indicator.id}>{indicator.name} ({indicator.code})</option>)}<option value={NEW_INDICATOR}>Nenhum destes — cadastrar novo indicador</option></select><span className={styles.fieldNote}>{isWaitingForNewIndicator ? "Cadastre o indicador na aba que abriu; ao voltar para esta aba, a lista é atualizada." : "Escolha o indicador que melhor corresponde ao conteúdo da coluna de valor."}</span></label>
        <label>Qual coluna identifica o município?<select onChange={(event) => updateMapping("municipalityField", event.target.value)} required value={mapping.municipalityField}><option disabled value="">Selecione uma coluna</option>{hasPreparedMunicipalityCode ? <option value={PREPARED_MUNICIPALITY_FIELD}>Código IBGE preparado pelo Decsys</option> : null}{orderedColumns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}<option value={NOT_MUNICIPAL}>A planilha não é por município</option></select><span className={styles.fieldNote}>Escolha a coluna com o código IBGE; códigos de 6 dígitos (padrão CAGED e DATASUS) são convertidos automaticamente. Se a fonte traz nomes, localize os códigos no quadro acima.</span></label>
        {isNotMunicipal ? <StatusNotice variant="warning" title="O painel municipal precisa de um município por linha">Dados por UF, região, bairro ou país não entram neste painel. Você ainda pode baixar a base completa no topo desta etapa e manter a importação salva para revisão.</StatusNotice> : <>
          <PeriodFields columns={sourceProfile.columns} hasPreparedPeriod={preparedGranularity !== null} onChange={setPeriod} preparedGranularity={preparedGranularity} selection={period} />
          <label>Qual coluna contém o valor?<select onChange={(event) => updateMapping("valueField", event.target.value)} required value={mapping.valueField}><option disabled value="">Selecione uma coluna</option>{preparedGranularity ? <option value="value">Valor preparado a partir da coluna de período</option> : null}{sourceProfile.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select><span className={styles.fieldNote}>Aceita formato brasileiro (1.234,5) e percentuais (12,5%). O símbolo % é removido; informe-o na unidade.</span></label>
          <label>Em que unidade o valor está medido?<input onChange={(event) => setUnit(event.target.value)} required value={unit} /><span className={styles.fieldNote}>Confira a unidade na fonte, por exemplo: pessoas, %, reais ou casos por 100 mil habitantes.</span></label>
          {selectedIndicator && indicatorGranularity && indicatorGranularity !== granularity ? <StatusNotice variant="warning" title="Periodicidade diferente do indicador">{selectedIndicator.name} está cadastrado como {indicatorGranularity === "month" ? "mensal" : "anual"}, mas o período escolhido é {granularity === "month" ? "mensal" : "anual"}. Confira se a fonte e o indicador medem a mesma coisa.</StatusNotice> : null}
          {selectedIndicator && unit.trim() && !sameUnit(unit, selectedIndicator.unit) ? <StatusNotice variant="warning" title="Unidade diferente da cadastrada">O indicador usa “{selectedIndicator.unit}”. Os valores serão gravados como “{unit}”; painéis que comparam municípios podem misturar escalas.</StatusNotice> : null}
        </>}
        {resultMessage ? <StatusNotice variant={resultMessageKind}>{resultMessage}</StatusNotice> : null}
        <ValidationIssueList fieldLabels={fieldLabels} issues={validationIssues} />
        <button className={`${styles.primaryButton} ${styles.mappingSubmit}`} disabled={!canSubmit} type="submit">{isApproving ? "Verificando linhas..." : "Validar e gravar no painel municipal"}</button>
        {isApproving ? <StatusNotice variant="loading">Estamos preparando período e valor e conferindo município, período e valor em cada linha. Planilhas grandes podem levar alguns instantes.</StatusNotice> : null}
      </form>
    </> : null}
  </section>;
}
