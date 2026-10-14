"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, GitCompareArrows, X } from "lucide-react";
import styles from "../../page.module.css";
import panels from "../../_components/iiu/paineis.module.css";
import { StatusNotice } from "../../_components/status-notice";
import { MunicipalitySearch } from "../../_components/iiu/buscar-municipio";
import { importErrorMessage } from "@/lib/import-error-message";
import { csvFileName, downloadCsv } from "@/lib/csv";
import { bestIndexes, compareQueryString, comparisonToCsv, maxCompared, minCompared, parseCodesParam } from "@/lib/iiu-compare";
import type { IiuCityProfile, IiuComparison, IiuCompareDimension, IiuCompareIndicator } from "@/lib/types/iiu-paineis";

const cityProfiles: { value: IiuCityProfile; label: string }[] = [
  { value: "pequeno", label: "Pequeno - até 50 mil habitantes" },
  { value: "medio", label: "Médio - 50 a 300 mil habitantes" },
  { value: "grande", label: "Grande - 300 mil a 1 milhão" },
  { value: "metropole", label: "Metrópole - acima de 1 milhão" },
];

const seriesClasses = [panels.series1, panels.series2, panels.series3, panels.series4];

function formatNumber(value: number | null, digits = 1) {
  return value === null ? "-" : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(value);
}

function ScoreCell({ score, isBest, className }: { score: number | null; isBest: boolean; className: string }) {
  if (score === null) return <td className={panels.empty}>sem dado</td>;
  return <td className={isBest ? panels.best : undefined}>
    <span className={`${panels.scoreLine} ${className}`}><span className={panels.barTrack}><i className={panels.barFill} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} /></span><strong>{formatNumber(score)}</strong></span>
    {isBest ? <small className={panels.cellValue}>maior nota</small> : null}
  </td>;
}

export default function IiuComparePage() {
  const [chosen, setChosen] = useState<{ code: string; name: string }[]>([]);
  const [cityProfile, setCityProfile] = useState<IiuCityProfile>("medio");
  const [comparison, setComparison] = useState<IiuComparison | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");

  const runComparison = useCallback(async (codes: string[], profile: IiuCityProfile) => {
    setIsLoading(true);
    setMessage("");
    try {
      const response = await fetch(`/api/iiu-compare?${compareQueryString(codes, profile)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível comparar os municípios."));
      const payload = await response.json() as IiuComparison;
      if (!payload || !Array.isArray(payload.municipalities)) throw new Error("A comparação veio em um formato inesperado.");
      setComparison(payload);
      setChosen(payload.municipalities.map((municipality) => ({ code: municipality.municipality_ibge_code, name: municipality.name ?? municipality.municipality_ibge_code })));
      window.history.replaceState(null, "", `?codigos=${codes.join(",")}&porte=${profile}`);
    } catch (compareError) {
      setComparison(null);
      setMessage(compareError instanceof Error ? compareError.message : "Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const codes = parseCodesParam(parameters.get("codigos"));
    const profile = cityProfiles.find((candidate) => candidate.value === parameters.get("porte"))?.value ?? "medio";
    setCityProfile(profile);
    if (codes.length) {
      setChosen(codes.map((code) => ({ code, name: code })));
      if (codes.length >= minCompared) void runComparison(codes, profile);
    }
  }, [runComparison]);

  function removeMunicipality(code: string) {
    setChosen((current) => current.filter((item) => item.code !== code));
  }

  const dimensions: IiuCompareDimension[] = comparison?.municipalities[0]?.dimensions ?? [];
  const municipalities = comparison?.municipalities ?? [];
  const canCompare = chosen.length >= minCompared && chosen.length <= maxCompared && !isLoading;
  const dimensionOf = (municipalityIndex: number, code: string) => municipalities[municipalityIndex].dimensions.find((dimension) => dimension.code === code);
  const header = <tr><th scope="col">{""}</th>{municipalities.map((municipality, index) => <th className={seriesClasses[index]} key={municipality.municipality_ibge_code} scope="col"><span className={panels.swatch} /> {municipality.name ?? municipality.municipality_ibge_code}{municipality.state ? ` - ${municipality.state}` : ""}</th>)}</tr>;

  return <main className={styles.workspaceShell}>
    <section className={styles.workspaceIntro}>
      <p className={styles.eyebrow}>ÍNDICE DE INTELIGÊNCIA URBANA</p>
      <h1>Comparar municípios</h1>
      <p>Coloque de dois a quatro municípios lado a lado: nota geral, nota por dimensão e cada indicador, com o mesmo porte aplicado a todos.</p>
    </section>
    <section className={styles.analysisPanel}>
      <div className={styles.sectionHeading}><div><h2>Escolher municípios</h2><span>Pesquise pelo nome ou código IBGE e adicione de {minCompared} a {maxCompared} municípios.</span></div></div>
      <div className={styles.sourceForm} style={{ marginTop: "var(--space-4)" }}>
        <div className={panels.controls}>
          <MunicipalitySearch disabled={chosen.length >= maxCompared} excludeCodes={chosen.map((item) => item.code)} label="Adicionar município" onSelect={(municipality) => setChosen((current) => current.length >= maxCompared ? current : [...current, { code: municipality.ibge_code, name: `${municipality.name} - ${municipality.state}` }])} />
          <label>Porte aplicado a todos<select onChange={(event) => setCityProfile(event.target.value as IiuCityProfile)} value={cityProfile}>{cityProfiles.map((profile) => <option key={profile.value} value={profile.value}>{profile.label}</option>)}</select><span className={styles.fieldNote}>Usar o mesmo porte mantém as notas comparáveis.</span></label>
        </div>
        {chosen.length ? <ul aria-label="Municípios escolhidos" className={panels.chips}>{chosen.map((item, index) => <li className={`${panels.chip} ${seriesClasses[index]}`} key={item.code}><span className={panels.swatch} />{item.name}<button aria-label={`Remover ${item.name}`} onClick={() => removeMunicipality(item.code)} type="button"><X size={14} /></button></li>)}</ul> : null}
        <div className={styles.stepActions}>
          <button className={styles.primaryButton} disabled={!canCompare} onClick={() => void runComparison(chosen.map((item) => item.code), cityProfile)} type="button"><GitCompareArrows size={16} />{isLoading ? "Comparando..." : "Comparar"}</button>
        </div>
        {chosen.length === 1 ? <span className={styles.fieldNote}>Escolha ao menos mais um município.</span> : null}
      </div>
    </section>
    {isLoading ? <StatusNotice variant="loading">Calculando o diagnóstico de cada município. Isso pode levar alguns instantes.</StatusNotice> : null}
    {message ? <StatusNotice variant="error">{message}</StatusNotice> : null}
    {comparison && !isLoading ? <div className={panels.panelStack}>
      <section aria-label="Resumo por município" className={panels.compareHeader}>{municipalities.map((municipality, index) => <article className={`${panels.compareCard} ${seriesClasses[index]}`} key={municipality.municipality_ibge_code}>
        <h2>{municipality.name ?? municipality.municipality_ibge_code}{municipality.state ? ` - ${municipality.state}` : ""}</h2>
        <strong className={panels.big}>{formatNumber(municipality.overall_score)}<span>/100</span></strong>
        <span>{municipality.maturity ?? "Sem dados suficientes para o índice."}</span>
        <span>{municipality.observed_indicators}/{municipality.total_indicators} indicadores com valor · {municipality.scored_indicators} com nota</span>
      </article>)}</section>
      <section className={styles.tableWorkspace}>
        <div className={styles.tableHeading}><div><p className={styles.eyebrow}>NOTAS</p><h2>Nota geral e por dimensão</h2></div><button onClick={() => downloadCsv(csvFileName("comparacao-iiu", comparison.city_profile), comparisonToCsv(comparison))} type="button"><Download size={16} />Exportar CSV</button></div>
        <div className={styles.tableWrap}>
          <table className={panels.compareTable}>
            <thead>{header}</thead>
            <tbody>
              {(() => { const best = bestIndexes(municipalities.map((municipality) => municipality.overall_score)); return <tr><th scope="row">Nota geral</th>{municipalities.map((municipality, index) => <ScoreCell className={seriesClasses[index]} isBest={best.has(index)} key={municipality.municipality_ibge_code} score={municipality.overall_score} />)}</tr>; })()}
              {dimensions.map((dimension) => {
                const scores = municipalities.map((_, index) => dimensionOf(index, dimension.code)?.score ?? null);
                const best = bestIndexes(scores);
                return <tr key={dimension.code}><th scope="row">{dimension.name}</th>{scores.map((score, index) => <ScoreCell className={seriesClasses[index]} isBest={best.has(index)} key={municipalities[index].municipality_ibge_code} score={score} />)}</tr>;
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className={styles.tableWorkspace}>
        <div className={styles.tableHeading}><div><p className={styles.eyebrow}>DETALHAMENTO</p><h2>Indicadores por dimensão</h2></div></div>
        {dimensions.map((dimension) => <details className={panels.dimensionDetails} key={dimension.code}>
          <summary><span className={panels.swatch} style={{ background: dimension.color }} />{dimension.name}<span className={styles.fieldNote}>{dimension.indicators.length} indicadores</span></summary>
          <div className={styles.tableWrap} style={{ border: 0, maxHeight: "none" }}>
            <table className={panels.compareTable}>
              <thead>{header}</thead>
              <tbody>{dimension.indicators.map((indicator) => {
                const matches = municipalities.map((_, index) => dimensionOf(index, dimension.code)?.indicators.find((candidate) => candidate.code === indicator.code));
                const best = bestIndexes(matches.map((match) => match?.score ?? null));
                return <tr key={indicator.code}><th scope="row">{indicator.name}<small className={panels.cellValue}>{indicator.unit}</small></th>{matches.map((match: IiuCompareIndicator | undefined, index) => <td className={match?.raw_value === null || match === undefined ? panels.empty : best.has(index) ? panels.best : undefined} key={municipalities[index].municipality_ibge_code}>{match?.raw_value === null || match === undefined ? "sem dado" : <span className={panels.cellValue}>{formatNumber(match.raw_value, 2)} {match.unit}<small>nota {formatNumber(match.score)}{match.reference_period ? ` · ${match.reference_period.slice(0, 4)}` : ""}</small></span>}</td>)}</tr>;
              })}</tbody>
            </table>
          </div>
        </details>)}
      </section>
    </div> : null}
  </main>;
}
