"use client";

import { FormEvent, useState } from "react";
import { ChartNoAxesCombined, Database, FileUp, Link2, ListTree, Search } from "lucide-react";
import styles from "../page.module.css";

type Municipality = { ibge_code: string; name: string; state: string };
type IiuIndicator = { code: string; name: string; unit: string; source: string; raw_value: number | null; reference_period: string | null; score: number | null; benchmark: { minimum: number; maximum: number } | null };
type IiuDimension = { code: string; name: string; color: string; weight: number; score: number | null; indicators: IiuIndicator[]; scored_indicators: number; observed_indicators: number; total_indicators: number };
type IiuDashboard = { municipality_ibge_code: string; city_profile: string; overall_score: number | null; maturity: string | null; observed_indicators: number; scored_indicators: number; total_indicators: number; dimensions: IiuDimension[] };

function formatNumber(value: number | null) {
  return value === null ? "—" : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value);
}

export default function IiuDashboardPage() {
  const [municipalityQuery, setMunicipalityQuery] = useState("");
  const [municipalities, setMunicipalities] = useState<Municipality[]>([]);
  const [cityProfile, setCityProfile] = useState("medio");
  const [dashboard, setDashboard] = useState<IiuDashboard | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function searchMunicipalities() {
    setMessage("");
    try {
      const response = await fetch(`/api/iiu-municipalities?search=${encodeURIComponent(municipalityQuery)}`);
      const payload = await response.json();
      if (!response.ok) setMessage(payload.detail ?? payload.message ?? "Não foi possível pesquisar municípios.");
      else setMunicipalities(payload);
    } catch {
      setMessage("Não foi possível acessar o serviço de tratamento.");
    }
  }

  async function loadDashboard(event?: FormEvent<HTMLFormElement>, selectedCode = municipalityQuery) {
    event?.preventDefault();
    if (!/^\d{7}$/.test(selectedCode)) {
      setMessage("Informe ou escolha um município pelo código IBGE de sete dígitos.");
      return;
    }
    setIsLoading(true);
    setMessage("");
    try {
      const response = await fetch(`/api/iiu-dashboard/${selectedCode}?city_profile=${cityProfile}`);
      const payload = await response.json();
      if (!response.ok) setMessage(payload.detail ?? payload.message ?? "Não foi possível calcular o IIU.");
      else setDashboard(payload);
    } catch {
      setMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsLoading(false);
    }
  }

  function selectMunicipality(municipality: Municipality) {
    setMunicipalityQuery(municipality.ibge_code);
    setMunicipalities([]);
    void loadDashboard(undefined, municipality.ibge_code);
  }

  return <div className={styles.applicationShell}>
    <aside className={styles.sidebar}><div className={styles.sidebarTop}><p className={styles.productName}>DECSYS</p><nav aria-label="Navegação principal"><a href="/"><FileUp size={20} strokeWidth={1.5} />Importações</a><a href="/dados-revisados"><Database size={20} strokeWidth={1.5} />Dados revisados</a><a href="/indicadores"><ListTree size={20} strokeWidth={1.5} />Indicadores</a><a className={styles.activeNav} href="/iiu"><ChartNoAxesCombined size={20} strokeWidth={1.5} />Índice IIU</a><a href="/#fontes"><Link2 size={20} strokeWidth={1.5} />Fontes</a></nav></div></aside>
    <main className={styles.workspaceShell}>
      <section className={styles.workspaceIntro}><p className={styles.eyebrow}>ÍNDICE DE INTELIGÊNCIA URBANA</p><h1>Diagnóstico IIU</h1><p>O índice converte dados municipais aprovados em scores de 0 a 100, mantendo as fontes, valores e lacunas visíveis.</p></section>
      <section className={styles.analysisPanel}><div className={styles.sectionHeading}><div><h2>Escolher município</h2><span>O porte define os pesos usados entre as sete dimensões.</span></div></div><form className={styles.sourceForm} onSubmit={loadDashboard}><label>Código IBGE ou nome do município<input onChange={(event) => setMunicipalityQuery(event.target.value)} placeholder="Ex.: 4314902 ou Porto Alegre" value={municipalityQuery} /></label><label>Porte do município<select onChange={(event) => setCityProfile(event.target.value)} value={cityProfile}><option value="pequeno">Pequeno — até 50 mil habitantes</option><option value="medio">Médio — 50 a 300 mil habitantes</option><option value="grande">Grande — 300 mil a 1 milhão</option><option value="metropole">Metrópole — acima de 1 milhão</option></select></label><div className={styles.stepActions}><button onClick={() => void searchMunicipalities()} type="button"><Search size={16} />Pesquisar município</button><button className={styles.primaryButton} disabled={isLoading} type="submit">{isLoading ? "Calculando..." : "Calcular IIU"}</button></div></form>{municipalities.length ? <div className={styles.municipalityResults}>{municipalities.map((municipality) => <button key={municipality.ibge_code} onClick={() => selectMunicipality(municipality)} type="button">{municipality.name} — {municipality.state}<span>{municipality.ibge_code}</span></button>)}</div> : null}</section>
      {message ? <p className={styles.feedbackMessage}>{message}</p> : null}
      {dashboard ? <><section className={styles.iiuOverview}><div><p className={styles.eyebrow}>SCORE GERAL</p><strong>{formatNumber(dashboard.overall_score)}</strong><span>{dashboard.maturity ?? "Ainda não há dados suficientes para calcular o índice."}</span></div><dl><div><dt>Indicadores recebidos</dt><dd>{dashboard.observed_indicators}/{dashboard.total_indicators}</dd></div><div><dt>Indicadores pontuados</dt><dd>{dashboard.scored_indicators}/{dashboard.total_indicators}</dd></div><div><dt>Porte aplicado</dt><dd>{dashboard.city_profile}</dd></div></dl></section><section className={styles.iiuDimensions}>{dashboard.dimensions.map((dimension) => <article className={styles.iiuDimension} key={dimension.code}><div className={styles.iiuDimensionHeading}><div><span style={{ background: dimension.color }}></span><h2>{dimension.name}</h2></div><strong>{formatNumber(dimension.score)}</strong></div><p>{dimension.scored_indicators}/{dimension.total_indicators} indicadores com score · peso {dimension.weight}%</p><div className={styles.tableWrap}><table><thead><tr><th>Indicador</th><th>Valor</th><th>Referência</th><th>Score</th><th>Fonte</th></tr></thead><tbody>{dimension.indicators.map((indicator) => <tr key={indicator.code}><td>{indicator.name}</td><td>{formatNumber(indicator.raw_value)} {indicator.unit}</td><td>{indicator.benchmark ? `${formatNumber(indicator.benchmark.minimum)} – ${formatNumber(indicator.benchmark.maximum)}` : "Aguardando calibração"}</td><td>{formatNumber(indicator.score)}</td><td>{indicator.source}</td></tr>)}</tbody></table></div></article>)}</section></> : null}
    </main>
  </div>;
}
