import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import styles from "../../page.module.css";
import { Indicator, SourceProfile } from "@/lib/types/importacao";
import { importErrorMessage } from "@/lib/import-error-message";
import { StatusNotice } from "../status-notice";

type MunicipalApprovalProps = { importId: string; sourceProfile: SourceProfile };
type ValidationIssue = { severity: string; row_number: number | null; field: string | null; message: string };

export function MunicipalApproval({ importId, sourceProfile }: MunicipalApprovalProps) {
  const recommendedIndicator = sourceProfile.indicator_recommendations?.[0];
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [isLoadingIndicators, setIsLoadingIndicators] = useState(true);
  const [indicatorLoadMessage, setIndicatorLoadMessage] = useState("");
  const [indicatorLoadAttempt, setIndicatorLoadAttempt] = useState(0);
  const [indicatorId, setIndicatorId] = useState("");
  const [municipalityField, setMunicipalityField] = useState(sourceProfile.suggestions.municipality_code ?? "");
  const [yearField, setYearField] = useState(sourceProfile.suggestions.reference_year ?? "");
  const [valueField, setValueField] = useState(sourceProfile.suggestions.value ?? recommendedIndicator?.value_field ?? "");
  const [unit, setUnit] = useState("");
  const [isApproving, setIsApproving] = useState(false);
  const [resultMessage, setResultMessage] = useState("");
  const [resultMessageKind, setResultMessageKind] = useState<"error" | "success">("error");
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([]);
  const [approvedRows, setApprovedRows] = useState<number | null>(null);
  const [wideMeasureField, setWideMeasureField] = useState(recommendedIndicator?.value_field ?? "");
  const [isNormalizing, setIsNormalizing] = useState(false);
  const [normalizationMessage, setNormalizationMessage] = useState("");
  const [normalizationMessageKind, setNormalizationMessageKind] = useState<"error" | "success">("error");

  useEffect(() => {
    let cancelled = false;
    setIsLoadingIndicators(true);
    setIndicatorLoadMessage("");
    fetch("/api/indicators", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível carregar a lista de indicadores."));
        const payload: unknown = await response.json();
        if (!Array.isArray(payload)) throw new Error("A lista de indicadores veio em um formato inesperado. Tente carregar novamente.");
        return payload as Indicator[];
      })
      .then((indicatorList) => {
        if (cancelled) return;
        setIndicators(indicatorList);
        if (indicatorList[0]) {
          setIndicatorId((currentIndicatorId) => indicatorList.some((indicator) => indicator.id === currentIndicatorId) ? currentIndicatorId : indicatorList[0].id);
          setUnit(indicatorList[0].unit);
        }
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setIndicatorLoadMessage(loadError instanceof Error ? loadError.message : "Não conseguimos carregar os indicadores. Tente novamente.");
      })
      .finally(() => {
        if (!cancelled) setIsLoadingIndicators(false);
      });
    return () => { cancelled = true; };
  }, [indicatorLoadAttempt]);

  function selectIndicator(event: ChangeEvent<HTMLSelectElement>) {
    const selectedId = event.target.value;
    setIndicatorId(selectedId);
    const selectedIndicator = indicators.find((indicator) => indicator.id === selectedId);
    if (selectedIndicator) setUnit(selectedIndicator.unit);
  }

  async function normalizeWideTable() {
    setIsNormalizing(true);
    setNormalizationMessage("");
    try {
      const response = await fetch(`/api/imports/${importId}/normalize-municipal-wide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ municipality_field: municipalityField, value_field: wideMeasureField, sheet_name: sourceProfile.selected_sheet }) });
      if (!response.ok) {
        setNormalizationMessageKind("error");
        setNormalizationMessage(await importErrorMessage(response, "Não conseguimos preparar os registros desta coluna."));
      }
      else {
        const payload = await response.json();
        setMunicipalityField(payload.municipality_field);
        setYearField(payload.year_field);
        setValueField(payload.value_field);
        setNormalizationMessageKind("success");
        setNormalizationMessage(`${payload.transformed_rows.toLocaleString("pt-BR")} registros foram preparados para ${new Date(`${payload.reference_period}T12:00:00`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}. ${payload.skipped_rows ? `${payload.skipped_rows.toLocaleString("pt-BR")} linhas sem código IBGE ou valor ficaram fora.` : ""}`);
      }
    } catch {
      setNormalizationMessageKind("error");
      setNormalizationMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsNormalizing(false);
    }
  }

  async function submitApproval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsApproving(true);
    setResultMessage("");
    try {
      const response = await fetch(`/api/imports/${importId}/approve-municipal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ indicator_id: indicatorId, municipality_field: municipalityField, year_field: yearField, value_field: valueField, unit, sheet_name: sourceProfile.selected_sheet }) });
      if (!response.ok) {
        setResultMessageKind("error");
        setResultMessage(await importErrorMessage(response, "Não foi possível gravar os dados. Confira os campos escolhidos e tente novamente."));
      }
      else {
        const payload = await response.json();
        const issuesResponse = await fetch(`/api/imports/${importId}/validation-issues`, { cache: "no-store" });
        if (issuesResponse.ok) {
          const issuesPayload: unknown = await issuesResponse.json();
          if (Array.isArray(issuesPayload)) setValidationIssues(issuesPayload);
          else {
            setResultMessageKind("error");
            setResultMessage("Os dados foram verificados, mas a lista de pendências veio em um formato inesperado. Atualize a página para tentar carregar novamente.");
          }
        } else {
          setResultMessageKind("error");
          setResultMessage(await importErrorMessage(issuesResponse, "A verificação terminou, mas não conseguimos mostrar as linhas pendentes."));
        }
        if (payload.approved_rows > 0) {
          setApprovedRows(payload.approved_rows);
          if (!issuesResponse.ok) setResultMessageKind("error");
          else setResultMessageKind("success");
        } else {
          setResultMessageKind("error");
          if (issuesResponse.ok) setResultMessage("Nenhuma linha foi gravada. Veja as pendências, corrija a origem ou as colunas escolhidas e tente novamente.");
        }
      }
    } catch {
      setResultMessageKind("error");
      setResultMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsApproving(false);
    }
  }

  if (approvedRows !== null) return <section className={styles.analysisPanel}><h2>Dados gravados no painel municipal</h2><StatusNotice variant="success" title={`${approvedRows.toLocaleString("pt-BR")} linhas válidas gravadas.`}>{validationIssues.length ? `${validationIssues.length.toLocaleString("pt-BR")} linhas precisam de revisão.` : "Todas as linhas selecionadas passaram pela validação."}</StatusNotice>{resultMessage ? <StatusNotice variant={resultMessageKind}>{resultMessage}</StatusNotice> : null}{validationIssues.length ? <><h3 className={styles.issueHeading}>Linhas para revisar</h3><ul className={styles.validationIssueList}>{validationIssues.slice(0, 20).map((validationIssue, issuePosition) => <li key={`${validationIssue.row_number}-${validationIssue.field}-${issuePosition}`}><strong>{validationIssue.row_number ? `Linha ${validationIssue.row_number}` : "Arquivo"}{validationIssue.field ? ` · ${validationIssue.field}` : ""}:</strong> {validationIssue.message}</li>)}</ul></> : null}{validationIssues.length > 20 ? <p className={styles.profileGuidance}>Exibindo 20 de {validationIssues.length.toLocaleString("pt-BR")} pendências.</p> : null}</section>;

  return <section className={styles.analysisPanel}>
    <h2>Gravar no painel municipal</h2>
    <p className={styles.profileGuidance}>Associe as colunas a um indicador já cadastrado. O catálogo de indicadores fica em uma área própria para não misturar cadastro com importação.</p>
    {sourceProfile.columns.some((column) => /(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)_20\d{2}/.test(column.name.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))) ? <section className={styles.processHint}>
      <strong>Planilha com períodos nas colunas</strong>
      <p>Esta fonte organiza cada mês em uma coluna. Escolha um indicador mensal para transformá-lo em registros de município, período e valor antes da aprovação.</p>
      <label>Coluna do indicador mensal<select onChange={(event) => setWideMeasureField(event.target.value)} value={wideMeasureField}><option value="">Selecione uma coluna</option>{sourceProfile.columns.filter((column) => /(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)_20\d{2}/.test(column.name.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))).map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label>
      {isNormalizing ? <StatusNotice variant="loading">Preparando os valores mensais para revisão.</StatusNotice> : null}
      {normalizationMessage ? <StatusNotice variant={normalizationMessageKind}>{normalizationMessage}</StatusNotice> : null}
      <button disabled={isNormalizing || !municipalityField || !wideMeasureField} onClick={normalizeWideTable} type="button">{isNormalizing ? "Transformando..." : "Preparar registros mensais"}</button>
    </section> : null}
    {sourceProfile.indicator_recommendations?.length ? <div className={styles.indicatorRecommendations}><p className={styles.fieldNote}>Sugestões automáticas pelo conteúdo da planilha. Confira se o indicador representa a mesma informação antes de continuar.</p>{sourceProfile.indicator_recommendations.map((recommendation) => <div className={styles.indicatorRecommendation} key={recommendation.code}><div><strong>{recommendation.name}</strong><p>{recommendation.unit} · coluna sugerida: {recommendation.value_field}</p></div></div>)}</div> : null}
    {isLoadingIndicators ? <StatusNotice variant="loading">Carregando os indicadores cadastrados.</StatusNotice> : null}
    {indicatorLoadMessage ? <StatusNotice action={{ label: "Tentar novamente", onClick: () => setIndicatorLoadAttempt((attempt) => attempt + 1) }} variant="error">{indicatorLoadMessage}</StatusNotice> : null}
    {!isLoadingIndicators && !indicatorLoadMessage && indicators.length === 0 ? <section className={styles.processHint}><strong>Ainda não há indicadores cadastrados</strong><p>Para enviar dados ao painel municipal, primeiro cadastre o indicador que descreve o que esta planilha mede. Você pode continuar exportando os dados sem fazer esse cadastro.</p><a className={styles.sourceLink} href="/indicadores/novo">Cadastrar primeiro indicador</a></section> : null}
    {!isLoadingIndicators && !indicatorLoadMessage && indicators.length > 0 ? <><a className={styles.sourceLink} href="/indicadores">Ver e organizar indicadores</a><p className={styles.fieldNote}>Associe cada campo da planilha ao dado correspondente. As linhas com código de município, ano ou valor inválidos ficam fora da gravação e aparecem abaixo para revisão.</p><form className={styles.sourceForm} onSubmit={submitApproval}>
      <label>O que esta planilha mede?<select onChange={selectIndicator} required value={indicatorId}><option disabled value="">Selecione um indicador</option>{indicators.map((indicator) => <option key={indicator.id} value={indicator.id}>{indicator.name} ({indicator.code})</option>)}</select><span className={styles.fieldNote}>Escolha o indicador que melhor corresponde ao conteúdo da coluna de valor.</span></label>
      <label>Qual coluna identifica o município?<input onChange={(event) => setMunicipalityField(event.target.value)} required value={municipalityField} /><span className={styles.fieldNote}>Geralmente contém o código IBGE de sete dígitos. A coluna sugerida pode ser ajustada.</span></label>
      <label>Qual coluna informa o ano?<input onChange={(event) => setYearField(event.target.value)} required value={yearField} /><span className={styles.fieldNote}>O ano deve estar entre 1900 e 2200. Planilhas mensais podem preencher este campo após a preparação.</span></label>
      <label>Qual coluna contém o valor?<input onChange={(event) => setValueField(event.target.value)} required value={valueField} /><span className={styles.fieldNote}>Use uma coluna numérica, como população, taxa ou quantidade.</span></label>
      <label>Em que unidade o valor está medido?<input onChange={(event) => setUnit(event.target.value)} required value={unit} /><span className={styles.fieldNote}>Exemplos: pessoas, %, reais ou casos por 100 mil habitantes.</span></label>
      {resultMessage ? <StatusNotice variant={resultMessageKind}>{resultMessage}</StatusNotice> : null}
      {validationIssues.length ? <><h3 className={styles.issueHeading}>Linhas para revisar</h3><ul className={styles.validationIssueList}>{validationIssues.slice(0, 20).map((validationIssue, issuePosition) => <li key={`${validationIssue.row_number}-${validationIssue.field}-${issuePosition}`}><strong>{validationIssue.row_number ? `Linha ${validationIssue.row_number}` : "Arquivo"}{validationIssue.field ? ` · ${validationIssue.field}` : ""}:</strong> {validationIssue.message}</li>)}</ul></> : null}
      <button className={styles.primaryButton} disabled={isApproving || !indicatorId} type="submit">{isApproving ? "Verificando linhas..." : "Validar e gravar no painel municipal"}</button>
      {isApproving ? <StatusNotice variant="loading">Estamos conferindo município, ano e valor em cada linha. Planilhas grandes podem levar alguns instantes.</StatusNotice> : null}
    </form></> : null}
  </section>;
}
