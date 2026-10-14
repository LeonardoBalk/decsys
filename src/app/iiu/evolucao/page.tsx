"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Download } from "lucide-react";
import styles from "../../page.module.css";
import panels from "../../_components/iiu/paineis.module.css";
import { StatusNotice } from "../../_components/status-notice";
import { MunicipalitySearch } from "../../_components/iiu/buscar-municipio";
import { importErrorMessage } from "@/lib/import-error-message";
import { csvFileName, downloadCsv } from "@/lib/csv";
import { chartGeometry, formatSeriesValue, numericPoints, summarizeSeries, timeseriesToCsv, type ChartFrame } from "@/lib/iiu-timeseries";
import type { IiuTimeseries, IiuTimeseriesIndicators } from "@/lib/types/iiu-paineis";

const frame: ChartFrame = { width: 720, height: 300, left: 56, right: 16, top: 16, bottom: 32 };

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw new Error(await importErrorMessage(response, fallback));
  return await response.json() as T;
}

function SeriesChart({ series }: { series: IiuTimeseries }) {
  const points = useMemo(() => numericPoints(series.points), [series.points]);
  const geometry = useMemo(() => chartGeometry(points, frame), [points]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  function trackPointer(event: MouseEvent<SVGRectElement>) {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || !geometry.dots.length) return;
    const pointerX = ((event.clientX - box.left) / box.width) * frame.width;
    let nearest = 0;
    geometry.dots.forEach((dot, index) => { if (Math.abs(dot.x - pointerX) < Math.abs(geometry.dots[nearest].x - pointerX)) nearest = index; });
    setActiveIndex(nearest);
  }

  const active = activeIndex === null ? null : geometry.dots[activeIndex];
  const unit = series.indicator?.unit ?? "";
  const baseline = frame.height - frame.bottom;

  return <div className={panels.chartFrame}>
    <svg aria-label={`Evolução de ${series.indicator?.name ?? "indicador"} em ${series.municipality_name}, ${points.length} períodos`} className={panels.chart} ref={svgRef} role="img" viewBox={`0 0 ${frame.width} ${frame.height}`}>
      {geometry.yTicks.map((tick) => <g key={tick.value}><line className={panels.gridLine} x1={frame.left} x2={frame.width - frame.right} y1={tick.y} y2={tick.y} /><text className={panels.axisLabel} textAnchor="end" x={frame.left - 8} y={tick.y + 4}>{formatSeriesValue(tick.value)}</text></g>)}
      {geometry.xTicks.map((tick) => <text className={panels.axisLabel} key={tick.x} textAnchor="middle" x={tick.x} y={baseline + 20}>{tick.label}</text>)}
      {active ? <line className={panels.crosshair} x1={active.x} x2={active.x} y1={frame.top} y2={baseline} /> : null}
      {geometry.dots.length > 1 ? <path className={panels.seriesLine} d={geometry.path} /> : null}
      {geometry.dots.map((dot, index) => <circle className={index === activeIndex ? panels.seriesDotActive : panels.seriesDot} cx={dot.x} cy={dot.y} key={dot.point.period} r={index === activeIndex ? 5 : 4} />)}
      <rect className={panels.hitArea} height={frame.height - frame.top} onMouseLeave={() => setActiveIndex(null)} onMouseMove={trackPointer} width={frame.width - frame.left} x={frame.left} y={frame.top} />
    </svg>
    {active ? <div className={panels.tooltip} style={{ left: `${(active.x / frame.width) * 100}%`, top: `${(active.y / frame.height) * 100}%` }}>
      <span>{active.point.label}</span>
      <strong>{formatSeriesValue(active.point.value)} {unit}</strong>
      <span>{active.point.source}</span>
    </div> : null}
  </div>;
}

export default function IiuEvolutionPage() {
  const [municipality, setMunicipality] = useState<{ code: string; name: string } | null>(null);
  const [catalog, setCatalog] = useState<IiuTimeseriesIndicators | null>(null);
  const [indicatorCode, setIndicatorCode] = useState("");
  const [series, setSeries] = useState<IiuTimeseries | null>(null);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [isLoadingSeries, setIsLoadingSeries] = useState(false);
  const [message, setMessage] = useState("");
  const [initialIndicator, setInitialIndicator] = useState("");

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const code = parameters.get("municipio") ?? "";
    if (/^\d{7}$/.test(code)) {
      setMunicipality({ code, name: code });
      setInitialIndicator(parameters.get("indicador") ?? "");
    }
  }, []);

  const municipalityCode = municipality?.code ?? "";

  useEffect(() => {
    if (!municipalityCode) return;
    let cancelled = false;
    setIsLoadingCatalog(true);
    setMessage("");
    setCatalog(null);
    setSeries(null);
    fetch(`/api/iiu-timeseries/${municipalityCode}`, { cache: "no-store" })
      .then((response) => readJson<IiuTimeseriesIndicators>(response, "Não foi possível listar os indicadores do município."))
      .then((payload) => {
        if (cancelled) return;
        setCatalog(payload);
        setMunicipality({ code: municipalityCode, name: `${payload.municipality_name} - ${payload.state}` });
        setIndicatorCode((current) => [current, initialIndicator].find((candidate) => candidate && payload.indicators.some((indicator) => indicator.code === candidate)) ?? payload.indicators[0]?.code ?? "");
      })
      .catch((loadError: unknown) => { if (!cancelled) setMessage(loadError instanceof Error ? loadError.message : "Não foi possível acessar o serviço de tratamento."); })
      .finally(() => { if (!cancelled) setIsLoadingCatalog(false); });
    return () => { cancelled = true; };
  }, [municipalityCode, initialIndicator]);

  useEffect(() => {
    if (!municipalityCode || !indicatorCode) return;
    let cancelled = false;
    setIsLoadingSeries(true);
    setMessage("");
    fetch(`/api/iiu-timeseries/${municipalityCode}?indicator_code=${encodeURIComponent(indicatorCode)}`, { cache: "no-store" })
      .then((response) => readJson<IiuTimeseries>(response, "Não foi possível carregar a série do indicador."))
      .then((payload) => {
        if (cancelled) return;
        setSeries(payload);
        window.history.replaceState(null, "", `?municipio=${municipalityCode}&indicador=${encodeURIComponent(indicatorCode)}`);
      })
      .catch((loadError: unknown) => { if (!cancelled) { setSeries(null); setMessage(loadError instanceof Error ? loadError.message : "Não foi possível acessar o serviço de tratamento."); } })
      .finally(() => { if (!cancelled) setIsLoadingSeries(false); });
    return () => { cancelled = true; };
  }, [municipalityCode, indicatorCode]);

  function chooseMunicipality(next: { ibge_code: string; name: string; state: string }) {
    setInitialIndicator("");
    setIndicatorCode("");
    setMunicipality({ code: next.ibge_code, name: `${next.name} - ${next.state}` });
  }

  const points = useMemo(() => numericPoints(series?.points ?? []), [series]);
  const summary = useMemo(() => summarizeSeries(points), [points]);
  const unit = series?.indicator?.unit ?? "";
  const changeText = summary ? `${summary.change >= 0 ? "+" : "-"}${formatSeriesValue(Math.abs(summary.change))} ${unit}${summary.changePercent === null ? "" : ` (${summary.changePercent >= 0 ? "+" : "-"}${Math.abs(summary.changePercent).toFixed(1).replace(".", ",")}%)`}` : "";

  return <main className={styles.workspaceShell}>
    <section className={styles.workspaceIntro}>
      <p className={styles.eyebrow}>ÍNDICE DE INTELIGÊNCIA URBANA</p>
      <h1>Evolução no tempo</h1>
      <p>Veja como um indicador de um município mudou ao longo dos períodos aprovados.</p>
    </section>
    <section className={styles.analysisPanel}>
      <div className={styles.sectionHeading}><div><h2>Município e indicador</h2><span>Só aparecem indicadores que o município já tem com valor aprovado.</span></div></div>
      <div className={styles.sourceForm} style={{ marginTop: "var(--space-4)" }}>
        <div className={panels.controls}>
          <MunicipalitySearch label={municipality ? "Trocar município" : "Município"} onSelect={chooseMunicipality} />
          <label>Indicador<select disabled={!catalog?.indicators.length} onChange={(event) => setIndicatorCode(event.target.value)} value={indicatorCode}>
            {!catalog ? <option value="">{municipality ? "Carregando..." : "Escolha um município primeiro"}</option> : null}
            {catalog?.indicators.map((indicator) => <option key={indicator.code} value={indicator.code}>{indicator.name} ({indicator.observations})</option>)}
          </select></label>
        </div>
        {municipality ? <p className={styles.fieldNote}>Município escolhido: <strong>{municipality.name}</strong> · {municipality.code}</p> : null}
      </div>
    </section>
    {isLoadingCatalog || isLoadingSeries ? <StatusNotice variant="loading">{isLoadingCatalog ? "Buscando os indicadores do município." : "Carregando a série do indicador."}</StatusNotice> : null}
    {message ? <StatusNotice variant="error">{message}</StatusNotice> : null}
    {catalog && !catalog.indicators.length && !isLoadingCatalog ? <StatusNotice variant="info">Este município ainda não tem valores aprovados. Importe e aprove dados para acompanhar a evolução.</StatusNotice> : null}
    {catalog?.truncated ? <StatusNotice variant="warning">O município tem muitos registros e a lista de indicadores pode estar incompleta.</StatusNotice> : null}
    {series && series.indicator && !isLoadingSeries ? <section className={styles.tableWorkspace} style={{ marginTop: "var(--space-4)" }}>
      <div className={styles.tableHeading}>
        <div><p className={styles.eyebrow}>{series.municipality_name.toUpperCase()} - {series.state}</p><h2>{series.indicator.name}</h2></div>
        <button onClick={() => downloadCsv(csvFileName("evolucao", series.municipality_name, series.indicator?.code), timeseriesToCsv(series))} type="button"><Download size={16} />Exportar CSV</button>
      </div>
      {points.length ? <>
        <SeriesChart series={series} />
        {summary ? <dl className={panels.facts}>
          <div><dt>Primeiro período</dt><dd>{formatSeriesValue(summary.first.value)} {unit}<small>{summary.first.label}</small></dd></div>
          <div><dt>Último período</dt><dd>{formatSeriesValue(summary.last.value)} {unit}<small>{summary.last.label}</small></dd></div>
          <div><dt>Variação</dt><dd>{points.length > 1 ? changeText : "-"}<small>{points.length > 1 ? `de ${summary.first.label} a ${summary.last.label}` : "só um período"}</small></dd></div>
          <div><dt>Maior valor</dt><dd>{formatSeriesValue(summary.max.value)} {unit}<small>{summary.max.label}</small></dd></div>
          <div><dt>Menor valor</dt><dd>{formatSeriesValue(summary.min.value)} {unit}<small>{summary.min.label}</small></dd></div>
        </dl> : null}
      </> : <p className={styles.profileGuidance}>Este indicador não tem valores numéricos para desenhar o gráfico.</p>}
      <details className={panels.dimensionDetails} style={{ marginTop: "var(--space-4)" }}>
        <summary>Ver tabela de valores ({series.points.length})</summary>
        <div className={styles.tableWrap} style={{ border: 0 }}>
          <table><thead><tr><th>Período</th><th>Valor</th><th>Fonte</th><th>Importação</th></tr></thead><tbody>{[...series.points].reverse().map((point) => <tr key={`${point.reference_period}-${point.import_title}`}><td>{point.reference_period}</td><td>{point.value === null ? "-" : `${formatSeriesValue(Number(point.value))} ${point.unit}`}</td><td>{point.source_name}</td><td>{point.import_title}</td></tr>)}</tbody></table>
        </div>
      </details>
    </section> : null}
  </main>;
}
