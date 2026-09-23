"use client";

import { FormEvent, useState } from "react";
import { ChartNoAxesCombined, Database, FileUp, ListTree, Search } from "lucide-react";
import styles from "../page.module.css";
import { StatusNotice } from "../_components/status-notice";

type Municipality = { ibge_code: string; name: string; state: string };
type IiuIndicator = { code: string; name: string; unit: string; source: string; raw_value: number | null; reference_period: string | null; score: number | null; benchmark: { minimum: number; maximum: number } | null };
type IiuDimension = { code: string; name: string; color: string; weight: number; score: number | null; indicators: IiuIndicator[]; scored_indicators: number; observed_indicators: number; total_indicators: number };
type IiuDashboard = { municipality_ibge_code: string; city_profile: string; is_demonstration: boolean; overall_score: number | null; maturity: string | null; observed_indicators: number; scored_indicators: number; total_indicators: number; dimensions: IiuDimension[] };

function formatNumber(value: number | null) {
  return value === null ? "-" : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value);
}

function radarPoint(index: number, radius: number, total: number) {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  return `${130 + Math.cos(angle) * radius},${130 + Math.sin(angle) * radius}`;
}

function ScoreRadar({ dimensions }: { dimensions: IiuDimension[] }) {
  const total = dimensions.length;
  const polygon = dimensions.map((dimension, index) => radarPoint(index, ((dimension.score ?? 0) / 100) * 91, total)).join(" ");

  return <svg aria-label="Radar de scores por dimensão" className={styles.scoreRadar} role="img" viewBox="0 0 260 260">
    {[18, 36, 54, 72, 91].map((radius) => <polygon className={styles.radarRing} key={radius} points={dimensions.map((_, index) => radarPoint(index, radius, total)).join(" ")} />)}
    {dimensions.map((dimension, index) => { const [x, y] = radarPoint(index, 91, total).split(","); return <line className={styles.radarAxis} key={dimension.code} x1="130" x2={x} y1="130" y2={y} />; })}
    <polygon className={styles.radarArea} points={polygon} />
    {dimensions.map((dimension, index) => { const [x, y] = radarPoint(index, 108, total).split(","); return <text className={styles.radarLabel} key={dimension.code} textAnchor="middle" x={x} y={Number(y) + 4}>{dimension.name}</text>; })}
  </svg>;
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
      const response = await fetch(`/api/iiu-municipalities?search=${encodeURIComponent(municipalityQuery)}`);
      const payload = await response.json();
      if (!response.ok) setMessage(payload.detail ?? payload.message ?? "Não foi possível pesquisar municípios.");
      else if (!Array.isArray(payload)) setMessage("A pesquisa retornou uma resposta inesperada. Tente novamente.");
      else {
        setMunicipalities(payload);
        setHasSearchedMunicipalities(true);
      }
    } catch {
      setMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsSearchingMunicipalities(false);
    }
  }

  async function loadDashboard(event?: FormEvent<HTMLFormElement>, selectedCode = municipalityQuery) {
    event?.preventDefault();
    if (selectedCode !== "demo" && !/^\d{7}$/.test(selectedCode)) {
      setMessage("Informe ou escolha um município pelo código IBGE de sete dígitos.");
      return;
    }
    setIsLoading(true);
    setMessage("");
    try {
      const response = await fetch(`/api/iiu-dashboard/${selectedCode}?city_profile=${cityProfile}`);
      const payload = await response.json();
      if (!response.ok) setMessage(payload.detail ?? payload.message ?? "Não foi possível calcular o IIU.");
      else {
        setDashboard(payload);
        setSelectedDimensionCode(payload.dimensions[0]?.code ?? "");
      }
    } catch {
      setMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsLoading(false);
    }
  }

  function selectMunicipality(municipality: Municipality) {
    setMunicipalityQuery(municipality.ibge_code);
    setMunicipalities([]);
    setHasSearchedMunicipalities(false);
    void loadDashboard(undefined, municipality.ibge_code);
  }

  const selectedDimension = dashboard?.dimensions.find((dimension) => dimension.code === selectedDimensionCode) ?? dashboard?.dimensions[0];
  const dimensionsWithScore = dashboard?.dimensions.filter((dimension) => dimension.score !== null) ?? [];
  const orderedDimensions = [...dimensionsWithScore].sort((first, second) => (second.score ?? 0) - (first.score ?? 0));
  const strongestDimension = orderedDimensions[0];
  const weakestDimension = orderedDimensions.at(-1);

  return <div className={styles.applicationShell}>
    <aside className={styles.sidebar}><div className={styles.sidebarTop}><p className={styles.productName}>DECSYS</p><nav aria-label="Navegação principal"><a href="/"><FileUp size={20} strokeWidth={1.5} />Importações</a><a href="/dados-revisados"><Database size={20} strokeWidth={1.5} />Dados revisados</a><a href="/indicadores"><ListTree size={20} strokeWidth={1.5} />Indicadores</a><a className={styles.activeNav} href="/iiu"><ChartNoAxesCombined size={20} strokeWidth={1.5} />Índice IIU</a></nav></div></aside>
    <main className={styles.workspaceShell}>
      <section className={styles.workspaceIntro}><p className={styles.eyebrow}>ÍNDICE DE INTELIGÊNCIA URBANA</p><h1>Diagnóstico IIU</h1><p>Uma leitura executiva do desempenho municipal, das lacunas de dados e dos indicadores que precisam de atenção.</p></section>
      <section className={styles.analysisPanel}><div className={styles.sectionHeading}><div><h2>Escolher município</h2><span>O porte define os pesos usados entre as sete dimensões.</span></div></div><form className={styles.sourceForm} onSubmit={loadDashboard}><label>Código IBGE ou nome do município<input onChange={(event) => { setMunicipalityQuery(event.target.value); setMunicipalities([]); setHasSearchedMunicipalities(false); }} placeholder="Ex.: 4314902 ou Porto Alegre" value={municipalityQuery} /></label><label>Porte do município<select onChange={(event) => setCityProfile(event.target.value)} value={cityProfile}><option value="pequeno">Pequeno - até 50 mil habitantes</option><option value="medio">Médio - 50 a 300 mil habitantes</option><option value="grande">Grande - 300 mil a 1 milhão</option><option value="metropole">Metrópole - acima de 1 milhão</option></select></label><div className={styles.stepActions}><button disabled={isSearchingMunicipalities || isLoading} onClick={() => void searchMunicipalities()} type="button"><Search size={16} />{isSearchingMunicipalities ? "Pesquisando..." : "Pesquisar município"}</button><button disabled={isLoading} onClick={() => void loadDashboard(undefined, "demo")} type="button">Ver demonstração</button><button className={styles.primaryButton} disabled={isLoading || isSearchingMunicipalities} type="submit">{isLoading ? "Calculando..." : "Calcular IIU"}</button></div></form>{isSearchingMunicipalities ? <StatusNotice variant="loading">Pesquisando municípios pelo nome ou código.</StatusNotice> : null}{municipalities.length ? <div className={styles.municipalityResults}>{municipalities.map((municipality) => <button key={municipality.ibge_code} onClick={() => selectMunicipality(municipality)} type="button">{municipality.name} - {municipality.state}<span>{municipality.ibge_code}</span></button>)}</div> : null}{hasSearchedMunicipalities && !isSearchingMunicipalities && !municipalities.length && !message ? <StatusNotice variant="info">Nenhum município encontrado. Confira a grafia ou tente o código IBGE.</StatusNotice> : null}</section>
      {isLoading ? <StatusNotice variant="loading">Calculando o diagnóstico do município. Isso pode levar alguns instantes.</StatusNotice> : null}
      {message ? <StatusNotice variant="error">{message}</StatusNotice> : null}
      {dashboard ? <>
        {dashboard.is_demonstration ? <StatusNotice variant="info" title="Modo de demonstração">Os valores são sintéticos e servem apenas para visualizar o IIU; não são gravados como dados oficiais.</StatusNotice> : null}
        <section className={styles.iiuScoreboard}><div className={styles.iiuScoreSummary}><p className={styles.eyebrow}>{dashboard.is_demonstration ? "DEMONSTRAÇÃO" : `MUNICÍPIO ${dashboard.municipality_ibge_code}`}</p><div className={styles.scoreNumber}><strong>{formatNumber(dashboard.overall_score)}</strong><span>/100</span></div><p>{dashboard.maturity ?? "Ainda não há dados suficientes para calcular o índice."}</p></div><dl className={styles.iiuScoreFacts}><div><dt>Cobertura</dt><dd>{dashboard.observed_indicators}/{dashboard.total_indicators}</dd><span>indicadores recebidos</span></div><div><dt>Scores calculados</dt><dd>{dashboard.scored_indicators}</dd><span>com referência disponível</span></div><div><dt>Porte aplicado</dt><dd>{dashboard.city_profile}</dd><span>pesos do diagnóstico</span></div></dl></section>
        <section className={styles.iiuDashboardGrid}><article className={styles.iiuRadarPanel}><div className={styles.iiuPanelHeading}><div><p className={styles.eyebrow}>VISÃO GERAL</p><h2>Equilíbrio entre dimensões</h2></div><span>{dimensionsWithScore.length}/7 avaliadas</span></div><ScoreRadar dimensions={dashboard.dimensions} /></article><article className={styles.iiuBarsPanel}><div className={styles.iiuPanelHeading}><div><p className={styles.eyebrow}>SCORES POR DIMENSÃO</p><h2>Onde agir primeiro</h2></div></div><div className={styles.iiuScoreBars}>{dashboard.dimensions.map((dimension) => <button className={selectedDimension?.code === dimension.code ? styles.iiuScoreBarActive : styles.iiuScoreBar} key={dimension.code} onClick={() => setSelectedDimensionCode(dimension.code)} type="button"><span>{dimension.name}</span><span className={styles.iiuBarTrack}><i style={{ background: dimension.color, width: `${dimension.score ?? 0}%` }} /></span><strong style={{ color: dimension.color }}>{formatNumber(dimension.score)}</strong></button>)}</div></article></section>
        <section className={styles.iiuInsightGrid}><article><p className={styles.eyebrow}>PONTO FORTE</p><strong>{strongestDimension?.name ?? "Sem score disponível"}</strong><span>{strongestDimension ? `${formatNumber(strongestDimension.score)} pontos` : "Importe dados com referência para calcular."}</span></article><article><p className={styles.eyebrow}>PRIORIDADE</p><strong>{weakestDimension?.name ?? "Sem score disponível"}</strong><span>{weakestDimension ? `${formatNumber(weakestDimension.score)} pontos` : "Importe dados com referência para calcular."}</span></article><article><p className={styles.eyebrow}>LACUNA DE DADOS</p><strong>{dashboard.total_indicators - dashboard.observed_indicators} indicadores</strong><span>Ainda não possuem valor aprovado para este diagnóstico.</span></article></section>
        {selectedDimension ? <section className={styles.iiuDimensionDetail}><div className={styles.iiuDimensionDetailHeading}><div><span style={{ background: selectedDimension.color }} /><div><p className={styles.eyebrow}>DETALHAMENTO</p><h2>{selectedDimension.name}</h2><p>{selectedDimension.scored_indicators}/{selectedDimension.total_indicators} indicadores com score e peso de {selectedDimension.weight}%.</p></div></div><strong>{formatNumber(selectedDimension.score)}</strong></div><div className={styles.tableWrap}><table><thead><tr><th>Indicador</th><th>Valor</th><th>Referência</th><th>Score</th><th>Fonte</th></tr></thead><tbody>{selectedDimension.indicators.map((indicator) => <tr key={indicator.code}><td>{indicator.name}</td><td>{formatNumber(indicator.raw_value)} {indicator.unit}</td><td>{indicator.benchmark ? `${formatNumber(indicator.benchmark.minimum)} - ${formatNumber(indicator.benchmark.maximum)}` : "Aguardando calibração"}</td><td>{formatNumber(indicator.score)}</td><td>{indicator.source}</td></tr>)}</tbody></table></div></section> : null}
      </> : null}
    </main>
  </div>;
}
