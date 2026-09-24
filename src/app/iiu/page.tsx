"use client";

import { FormEvent, useState } from "react";
import { Search } from "lucide-react";
import styles from "../page.module.css";
import { StatusNotice } from "../_components/status-notice";
import { importErrorMessage } from "@/lib/import-error-message";

type Municipality = { ibge_code: string; name: string; state: string };
type IiuIndicator = { code: string; name: string; unit: string; source: string; raw_value: number | null; reference_period: string | null; score: number | null; benchmark: { minimum: number; maximum: number } | null };
type IiuDimension = { code: string; name: string; color: string; weight: number; score: number | null; indicators: IiuIndicator[]; scored_indicators: number; observed_indicators: number; total_indicators: number };
type IiuDashboard = { municipality_ibge_code: string; city_profile: string; is_demonstration: boolean; overall_score: number | null; maturity: string | null; observed_indicators: number; scored_indicators: number; total_indicators: number; dimensions: IiuDimension[] };

const cityProfiles = [
  { value: "pequeno", label: "Pequeno - até 50 mil habitantes" },
  { value: "medio", label: "Médio - 50 a 300 mil habitantes" },
  { value: "grande", label: "Grande - 300 mil a 1 milhão" },
  { value: "metropole", label: "Metrópole - acima de 1 milhão" },
];

function formatNumber(value: number | null) {
  return value === null ? "-" : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value);
}

function radarPoint(index: number, radius: number, total: number) {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  return { x: 130 + Math.cos(angle) * radius, y: 130 + Math.sin(angle) * radius };
}

function pointList(points: { x: number; y: number }[]) {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function ScoreRadar({ dimensions }: { dimensions: IiuDimension[] }) {
  const total = dimensions.length;
  if (total < 3) return <p className={styles.radarLegend}>O radar precisa de pelo menos três dimensões.</p>;
  const scoredPoints = dimensions.map((dimension, index) => ({ dimension, point: radarPoint(index, ((dimension.score ?? 0) / 100) * 91, total) })).filter(({ dimension }) => dimension.score !== null);
  const missingCount = total - scoredPoints.length;

  return <>
    <svg aria-label="Radar de scores por dimensão" className={styles.scoreRadar} role="img" viewBox="0 0 260 260">
      {[18, 36, 54, 72, 91].map((radius) => <polygon className={styles.radarRing} key={radius} points={pointList(dimensions.map((_, index) => radarPoint(index, radius, total)))} />)}
      {dimensions.map((dimension, index) => { const edge = radarPoint(index, 91, total); return <line className={dimension.score === null ? styles.radarAxisMissing : styles.radarAxis} key={dimension.code} x1="130" x2={edge.x} y1="130" y2={edge.y} />; })}
      {scoredPoints.length >= 3 ? <polygon className={styles.radarArea} points={pointList(scoredPoints.map(({ point }) => point))} /> : null}
      {scoredPoints.map(({ dimension, point }) => <circle className={styles.radarPoint} cx={point.x} cy={point.y} key={dimension.code} r="2.5" />)}
      {dimensions.map((dimension, index) => { const label = radarPoint(index, 108, total); return <text className={dimension.score === null ? styles.radarLabelMissing : styles.radarLabel} key={dimension.code} textAnchor="middle" x={label.x} y={label.y + 4}>{dimension.name}{dimension.score === null ? " (sem dado)" : ""}</text>; })}
    </svg>
    {missingCount ? <p className={styles.radarLegend}>Eixos tracejados não têm dados suficientes e ficam fora da área do radar; não significam nota zero.</p> : null}
  </>;
}

export default function IiuDashboardPage() {
  const [municipalityQuery, setMunicipalityQuery] = useState("");
  const [municipalities, setMunicipalities] = useState<Municipality[]>([]);
  const [cityProfile, setCityProfile] = useState("medio");
  const [dashboard, setDashboard] = useState<IiuDashboard | null>(null);
  const [selectedDimensionCode, setSelectedDimensionCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSearchingMunicipalities, setIsSearchingMunicipalities] = useState(false);
  const [hasSearchedMunicipalities, setHasSearchedMunicipalities] = useState(false);
  const [message, setMessage] = useState("");

  async function searchMunicipalities() {
    setMessage("");
    setMunicipalities([]);
    setHasSearchedMunicipalities(false);
    if (!municipalityQuery.trim()) {
      setMessage("Digite o nome ou o código IBGE do município para pesquisar.");
      return;
    }
    setIsSearchingMunicipalities(true);
    try {
      const response = await fetch(`/api/iiu-municipalities?search=${encodeURIComponent(municipalityQuery.trim())}`);
      if (!response.ok) setMessage(await importErrorMessage(response, "Não foi possível pesquisar municípios."));
      else {
        const payload: unknown = await response.json();
        if (!Array.isArray(payload)) setMessage("A pesquisa retornou uma resposta inesperada. Tente novamente.");
        else {
          setMunicipalities(payload as Municipality[]);
          setHasSearchedMunicipalities(true);
        }
      }
    } catch {
      setMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsSearchingMunicipalities(false);
    }
  }

  async function loadDashboard(selectedCode: string, selectedProfile = cityProfile) {
    setIsLoading(true);
    setMessage("");
    try {
      const response = await fetch(`/api/iiu-dashboard/${encodeURIComponent(selectedCode)}?city_profile=${selectedProfile}`);
      if (!response.ok) setMessage(await importErrorMessage(response, "Não foi possível calcular o IIU."));
      else {
        const payload: IiuDashboard = await response.json();
        setDashboard(payload);
        setSelectedDimensionCode((currentCode) => payload.dimensions.some((dimension) => dimension.code === currentCode) ? currentCode : payload.dimensions[0]?.code ?? "");
      }
    } catch {
      setMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsLoading(false);
    }
  }

  function submitMunicipality(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuery = municipalityQuery.trim();
    if (/^\d{7}$/.test(trimmedQuery)) void loadDashboard(trimmedQuery);
    else void searchMunicipalities();
  }

  function changeCityProfile(selectedProfile: string) {
    setCityProfile(selectedProfile);
    if (dashboard) void loadDashboard(dashboard.is_demonstration ? "demo" : dashboard.municipality_ibge_code, selectedProfile);
  }

  function selectMunicipality(municipality: Municipality) {
    setMunicipalityQuery(`${municipality.name} (${municipality.state})`);
    setMunicipalities([]);
    setHasSearchedMunicipalities(false);
    void loadDashboard(municipality.ibge_code);
  }

  const selectedDimension = dashboard?.dimensions.find((dimension) => dimension.code === selectedDimensionCode) ?? dashboard?.dimensions[0];
  const dimensionsWithScore = dashboard?.dimensions.filter((dimension) => dimension.score !== null) ?? [];
  const orderedDimensions = [...dimensionsWithScore].sort((first, second) => (second.score ?? 0) - (first.score ?? 0));
  const strongestDimension = orderedDimensions[0];
  const weakestDimension = orderedDimensions.length > 1 ? orderedDimensions.at(-1) : undefined;
  const missingIndicators = dashboard ? Math.max(dashboard.total_indicators - dashboard.observed_indicators, 0) : 0;
  const isCodeQuery = /^\d{7}$/.test(municipalityQuery.trim());
  const profileLabel = cityProfiles.find((profile) => profile.value === dashboard?.city_profile)?.label.split(" - ")[0] ?? dashboard?.city_profile;

  return <main className={styles.workspaceShell}>
    <section className={styles.workspaceIntro}><p className={styles.eyebrow}>ÍNDICE DE INTELIGÊNCIA URBANA</p><h1>Diagnóstico IIU</h1><p>Uma leitura executiva do desempenho municipal, das lacunas de dados e dos indicadores que precisam de atenção.</p></section>
    <section className={styles.analysisPanel}>
      <div className={styles.sectionHeading}><div><h2>Escolher município</h2><span>Digite o nome e pressione Enter para pesquisar, ou informe o código IBGE para calcular direto. O porte define os pesos entre as dimensões.</span></div></div>
      <form className={styles.sourceForm} onSubmit={submitMunicipality}>
        <label>Código IBGE ou nome do município<input onChange={(event) => { setMunicipalityQuery(event.target.value); setMunicipalities([]); setHasSearchedMunicipalities(false); }} placeholder="Ex.: 4314902 ou Porto Alegre" value={municipalityQuery} /></label>
        <label>Porte do município<select onChange={(event) => changeCityProfile(event.target.value)} value={cityProfile}>{cityProfiles.map((profile) => <option key={profile.value} value={profile.value}>{profile.label}</option>)}</select>{dashboard ? <span className={styles.fieldNote}>Trocar o porte recalcula o diagnóstico exibido.</span> : null}</label>
        <div className={styles.stepActions}>
          <button disabled={isLoading} onClick={() => void loadDashboard("demo")} type="button">Ver demonstração</button>
          <button className={styles.primaryButton} disabled={isSearchingMunicipalities || isLoading || !municipalityQuery.trim()} type="submit">{isCodeQuery ? (isLoading ? "Calculando..." : "Calcular IIU") : <><Search size={16} />{isSearchingMunicipalities ? "Pesquisando..." : "Pesquisar município"}</>}</button>
        </div>
      </form>
      {isSearchingMunicipalities ? <StatusNotice variant="loading">Pesquisando municípios pelo nome ou código.</StatusNotice> : null}
      {municipalities.length ? <div className={styles.municipalityResults}>{municipalities.map((municipality) => <button key={municipality.ibge_code} onClick={() => selectMunicipality(municipality)} type="button">{municipality.name} - {municipality.state}<span>{municipality.ibge_code}</span></button>)}</div> : null}
      {hasSearchedMunicipalities && !isSearchingMunicipalities && !municipalities.length && !message ? <StatusNotice variant="info">Nenhum município encontrado. Confira a grafia ou tente o código IBGE. Só aparecem municípios que já têm dados importados.</StatusNotice> : null}
    </section>
    {isLoading ? <StatusNotice variant="loading">Calculando o diagnóstico do município. Isso pode levar alguns instantes.</StatusNotice> : null}
    {message ? <StatusNotice variant="error">{message}</StatusNotice> : null}
    {dashboard ? <>
      {dashboard.is_demonstration ? <StatusNotice variant="info" title="Modo de demonstração">Os valores são sintéticos e servem apenas para visualizar o IIU; não são gravados como dados oficiais.</StatusNotice> : null}
      <section className={styles.iiuScoreboard}><div className={styles.iiuScoreSummary}><p className={styles.eyebrow}>{dashboard.is_demonstration ? "DEMONSTRAÇÃO" : `MUNICÍPIO ${dashboard.municipality_ibge_code}`}</p><div className={styles.scoreNumber}><strong>{formatNumber(dashboard.overall_score)}</strong><span>/100</span></div><p>{dashboard.maturity ?? "Ainda não há dados suficientes para calcular o índice."}</p></div><dl className={styles.iiuScoreFacts}><div><dt>Cobertura</dt><dd>{dashboard.observed_indicators}/{dashboard.total_indicators}</dd><span>indicadores recebidos</span></div><div><dt>Scores calculados</dt><dd>{dashboard.scored_indicators}</dd><span>com referência disponível</span></div><div><dt>Porte aplicado</dt><dd>{profileLabel}</dd><span>pesos do diagnóstico</span></div></dl></section>
      <section className={styles.iiuDashboardGrid}><article className={styles.iiuRadarPanel}><div className={styles.iiuPanelHeading}><div><p className={styles.eyebrow}>VISÃO GERAL</p><h2>Equilíbrio entre dimensões</h2></div><span>{dimensionsWithScore.length}/{dashboard.dimensions.length} avaliadas</span></div><ScoreRadar dimensions={dashboard.dimensions} /></article><article className={styles.iiuBarsPanel}><div className={styles.iiuPanelHeading}><div><p className={styles.eyebrow}>SCORES POR DIMENSÃO</p><h2>Onde agir primeiro</h2></div></div><div className={styles.iiuScoreBars}>{dashboard.dimensions.map((dimension) => <button aria-pressed={selectedDimension?.code === dimension.code} className={selectedDimension?.code === dimension.code ? styles.iiuScoreBarActive : styles.iiuScoreBar} key={dimension.code} onClick={() => setSelectedDimensionCode(dimension.code)} type="button"><span>{dimension.name}</span><span className={styles.iiuBarTrack}><i style={{ background: dimension.color, width: `${dimension.score ?? 0}%` }} /></span><strong style={{ color: dimension.score === null ? undefined : dimension.color }}>{dimension.score === null ? "sem dado" : formatNumber(dimension.score)}</strong></button>)}</div></article></section>
      <section className={styles.iiuInsightGrid}><article><p className={styles.eyebrow}>PONTO FORTE</p><strong>{strongestDimension?.name ?? "Sem score disponível"}</strong><span>{strongestDimension ? `${formatNumber(strongestDimension.score)} pontos` : "Importe dados com referência para calcular."}</span></article><article><p className={styles.eyebrow}>PRIORIDADE</p><strong>{weakestDimension?.name ?? "Sem comparação"}</strong><span>{weakestDimension ? `${formatNumber(weakestDimension.score)} pontos` : "É preciso ao menos duas dimensões avaliadas para comparar."}</span></article><article><p className={styles.eyebrow}>LACUNA DE DADOS</p><strong>{missingIndicators} indicadores</strong><span>Ainda não possuem valor aprovado para este diagnóstico.</span></article></section>
      {selectedDimension ? <section className={styles.iiuDimensionDetail}><div className={styles.iiuDimensionDetailHeading}><div><span style={{ background: selectedDimension.color }} /><div><p className={styles.eyebrow}>DETALHAMENTO</p><h2>{selectedDimension.name}</h2><p>{selectedDimension.scored_indicators}/{selectedDimension.total_indicators} indicadores com score e peso de {selectedDimension.weight}%.</p></div></div><strong>{formatNumber(selectedDimension.score)}</strong></div><div className={styles.tableWrap}><table><thead><tr><th>Indicador</th><th>Valor</th><th>Referência</th><th>Score</th><th>Fonte</th></tr></thead><tbody>{selectedDimension.indicators.map((indicator) => <tr key={indicator.code}><td>{indicator.name}</td><td>{indicator.raw_value === null ? "sem dado" : `${formatNumber(indicator.raw_value)} ${indicator.unit}`}</td><td>{indicator.benchmark ? `${formatNumber(indicator.benchmark.minimum)} - ${formatNumber(indicator.benchmark.maximum)}` : "Aguardando calibração"}</td><td>{formatNumber(indicator.score)}</td><td>{indicator.source}</td></tr>)}</tbody></table></div></section> : null}
    </> : null}
  </main>;
}
