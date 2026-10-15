"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FilterX, RefreshCw, X } from "lucide-react";
import styles from "../page.module.css";
import panels from "../_components/iiu/paineis.module.css";
import { StatusNotice } from "../_components/status-notice";
import { MunicipalitySearch } from "../_components/iiu/buscar-municipio";
import { IndicatorPicker } from "../_components/indicator-picker";
import { Indicator } from "@/lib/types/importacao";
import { importErrorMessage } from "@/lib/import-error-message";
import { formatReferencePeriod, hasMonthlyPeriods } from "@/lib/reference-period";
import { activeFilterCount, emptyReviewedFilters, normalizePeriodInput, periodFilterError, reviewedDimensions, reviewedValuesQuery, type ReviewedFilters } from "@/lib/period-filter";

type DashboardValue = {
  id: string;
  dataset_id: string | null;
  dataset_name: string | null;
  domain_name: string | null;
  indicator_code: string;
  indicator_name: string;
  dimensions: Record<string, string>;
  reference_period: string;
  value: number | string | null;
  unit: string;
  import_title: string;
  source_name: string;
  municipality_name: string | null;
  period_granularity?: "month" | "year";
};

type DashboardPage = { items: DashboardValue[]; total: number; limit: number; offset: number };

const PAGE_SIZE = 200;

function formatValue(value: DashboardValue["value"]) {
  if (value === null) return "-";
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(Number(value));
}

export default function ReviewedDataPage() {
  const [dashboardPage, setDashboardPage] = useState<DashboardPage>({ items: [], total: 0, limit: PAGE_SIZE, offset: 0 });
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [filters, setFilters] = useState<ReviewedFilters>(emptyReviewedFilters);
  const [municipalityLabel, setMunicipalityLabel] = useState("");
  const filtersRef = useRef(filters);
  const [searchText, setSearchText] = useState("");
  const [periodFromText, setPeriodFromText] = useState("");
  const [periodToText, setPeriodToText] = useState("");
  const [pageOffset, setPageOffset] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [reloadAttempt, setReloadAttempt] = useState(0);

  useEffect(() => {
    fetch("/api/indicators", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : [])
      .then((payload: unknown) => { if (Array.isArray(payload)) setIndicators(payload as Indicator[]); })
      .catch(() => undefined);
  }, []);

  const periodError = periodFilterError(periodFromText, periodToText);

  useEffect(() => { filtersRef.current = filters; }, [filters]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (periodFilterError(periodFromText, periodToText)) return;
      const nextFilters = { search: searchText.trim(), periodFrom: normalizePeriodInput(periodFromText) ?? "", periodTo: normalizePeriodInput(periodToText) ?? "" };
      const current = filtersRef.current;
      if (current.search === nextFilters.search && current.periodFrom === nextFilters.periodFrom && current.periodTo === nextFilters.periodTo) return;
      setFilters({ ...current, ...nextFilters });
      setPageOffset(0);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [searchText, periodFromText, periodToText]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setMessage("");
    fetch(`/api/dashboard-values?${reviewedValuesQuery(filters, PAGE_SIZE, pageOffset)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível carregar os dados revisados."));
        const payload = await response.json();
        if (!payload || !Array.isArray(payload.items)) throw new Error("Os dados revisados vieram em um formato inesperado.");
        return payload as DashboardPage;
      })
      .then((payload) => { if (!cancelled) setDashboardPage(payload); })
      .catch((loadError: unknown) => { if (!cancelled) setMessage(loadError instanceof Error ? loadError.message : "Não foi possível acessar o serviço de tratamento."); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [filters, pageOffset, reloadAttempt]);

  function reload() {
    setReloadAttempt((attempt) => attempt + 1);
  }

  function updateFilter(changes: Partial<ReviewedFilters>) {
    setFilters((current) => ({ ...current, ...changes }));
    setPageOffset(0);
  }

  function clearFilters() {
    setFilters(emptyReviewedFilters);
    setMunicipalityLabel("");
    setSearchText("");
    setPeriodFromText("");
    setPeriodToText("");
    setPageOffset(0);
  }

  const filterCount = activeFilterCount(filters);

  const visibleValues = dashboardPage.items;
  const monthlyIndicators = useMemo(() => {
    const periodsByIndicator = new Map<string, string[]>();
    for (const dashboardValue of visibleValues) periodsByIndicator.set(dashboardValue.indicator_code, [...(periodsByIndicator.get(dashboardValue.indicator_code) ?? []), dashboardValue.reference_period]);
    return new Set([...periodsByIndicator].filter(([, periods]) => hasMonthlyPeriods(periods)).map(([indicatorCode]) => indicatorCode));
  }, [visibleValues]);
  const years = visibleValues.map((dashboardValue) => Number(dashboardValue.reference_period.slice(0, 4))).filter(Number.isFinite);
  const periodRange = years.length ? (Math.min(...years) === Math.max(...years) ? String(years[0]) : `${Math.min(...years)}–${Math.max(...years)}`) : "-";
  const firstRow = dashboardPage.total ? dashboardPage.offset + 1 : 0;
  const lastRow = dashboardPage.offset + visibleValues.length;
  const hasMorePages = dashboardPage.total > PAGE_SIZE;

  return <main className={styles.workspaceShell}>
    <section className={styles.workspaceIntro}>
      <p className={styles.eyebrow}>CONFERÊNCIA</p>
      <h1>Dados revisados</h1>
      <p>Confira somente valores aprovados. O arquivo original e a fonte continuam vinculados a cada registro para facilitar a auditoria.</p>
    </section>
    <section className={styles.analysisPanel}>
      <div className={styles.sectionHeading}><div><h2>Visão geral</h2><span>Esta tela não inclui rascunhos nem importações descartadas.{hasMorePages ? " Período e fontes se referem à página exibida." : ""}</span></div><button disabled={isLoading} onClick={reload} type="button"><RefreshCw size={16} />Atualizar</button></div>
      <div className={styles.profileSummary}><dl><div><dt>Registros aprovados</dt><dd>{dashboardPage.total.toLocaleString("pt-BR")}</dd></div><div><dt>Indicadores {hasMorePages ? "nesta página" : ""}</dt><dd>{new Set(visibleValues.map((dashboardValue) => dashboardValue.indicator_code)).size}</dd></div><div><dt>Período {hasMorePages ? "nesta página" : ""}</dt><dd>{periodRange}</dd></div><div><dt>Fontes {hasMorePages ? "nesta página" : ""}</dt><dd>{new Set(visibleValues.map((dashboardValue) => dashboardValue.source_name)).size}</dd></div></dl></div>
    </section>
    <section className={styles.analysisPanel}>
      <div className={styles.sectionHeading}><div><h2>Filtrar a conferência</h2><span>Combine os filtros para encontrar rapidamente o que conferir. Indicadores com unidades diferentes permanecem separados.</span></div></div>
      <div className={styles.sourceForm} style={{ marginTop: "var(--space-4)" }}>
        <div className={panels.filterGrid}>
          <IndicatorPicker clearLabel="Todos os indicadores" indicators={indicators} onChange={(indicatorId) => updateFilter({ indicatorCode: indicators.find((indicator) => indicator.id === indicatorId)?.code ?? "" })} value={indicators.find((indicator) => indicator.code === filters.indicatorCode)?.id ?? ""} />
          <label>Dimensão<select onChange={(event) => updateFilter({ dimension: event.target.value })} value={filters.dimension}><option value="">Todas as dimensões</option>{reviewedDimensions.map((dimension) => <option key={dimension.value} value={dimension.value}>{dimension.label}</option>)}</select></label>
          <label>Buscar por nome ou sigla<input onChange={(event) => setSearchText(event.target.value)} placeholder="Ex.: emprego ou eco01" type="search" value={searchText} /></label>
          <label>Período inicial<input inputMode="numeric" onChange={(event) => setPeriodFromText(event.target.value)} placeholder="2020 ou 2020-05" value={periodFromText} /></label>
          <label>Período final<input inputMode="numeric" onChange={(event) => setPeriodToText(event.target.value)} placeholder="2024 ou 2024-12" value={periodToText} /></label>
          {filters.municipalityCode ? <div className={panels.activeMunicipality}><span className={styles.fieldNote}>Município</span><ul className={panels.chips}><li className={panels.chip}>{municipalityLabel}<button aria-label="Remover filtro de município" onClick={() => { setMunicipalityLabel(""); updateFilter({ municipalityCode: "" }); }} type="button"><X size={14} /></button></li></ul></div> : <MunicipalitySearch label="Município" onSelect={(municipality) => { setMunicipalityLabel(`${municipality.name} - ${municipality.state}`); updateFilter({ municipalityCode: municipality.ibge_code }); }} />}
        </div>
        {periodError ? <span className={styles.fieldNote} role="alert">{periodError}</span> : null}
        <div className={panels.filterActions}>
          <span>{filterCount ? `${filterCount} ${filterCount === 1 ? "filtro ativo" : "filtros ativos"}` : "Nenhum filtro ativo"}</span>
          <button disabled={!filterCount && !searchText && !periodFromText && !periodToText} onClick={clearFilters} type="button"><FilterX size={16} />Limpar filtros</button>
        </div>
      </div>
    </section>
    {isLoading ? <StatusNotice variant="loading">Carregando valores aprovados.</StatusNotice> : null}
    {message ? <StatusNotice action={{ label: "Tentar novamente", onClick: reload }} variant="error">{message}</StatusNotice> : null}
    {!isLoading && !message ? <section className={styles.tableWorkspace}>
      <div className={styles.tableHeading}><div><p className={styles.eyebrow}>VALORES PUBLICADOS</p><h2>Conferência por registro</h2></div><span>{firstRow.toLocaleString("pt-BR")}–{lastRow.toLocaleString("pt-BR")} de {dashboardPage.total.toLocaleString("pt-BR")}</span></div>
      {visibleValues.length ? <div className={styles.tableWrap}><table><thead><tr><th>Indicador</th><th>Período</th><th>Valor</th><th>Município</th><th>Fonte</th><th>Importação</th></tr></thead><tbody>{visibleValues.map((dashboardValue) => <tr key={dashboardValue.id}><td>{dashboardValue.indicator_name}</td><td>{formatReferencePeriod(dashboardValue.reference_period, dashboardValue.period_granularity ? dashboardValue.period_granularity === "month" : monthlyIndicators.has(dashboardValue.indicator_code))}</td><td>{formatValue(dashboardValue.value)} {dashboardValue.unit}</td><td title={dashboardValue.dimensions.municipality_ibge_code}>{dashboardValue.municipality_name ?? dashboardValue.dimensions.municipality_ibge_code ?? "-"}</td><td>{dashboardValue.source_name}</td><td>{dashboardValue.import_title}</td></tr>)}</tbody></table></div> : <p className={styles.profileGuidance}>{filterCount ? "Nenhum valor aprovado combina com estes filtros. Ajuste ou limpe os filtros para ver mais." : "Ainda não há valores aprovados. Salve uma importação, revise as colunas e aprove o indicador para ela aparecer aqui."}</p>}
      {hasMorePages ? <div className={styles.pagination}>
        <span>Página {Math.floor(dashboardPage.offset / PAGE_SIZE) + 1} de {Math.ceil(dashboardPage.total / PAGE_SIZE)}</span>
        <div>
          <button disabled={pageOffset === 0} onClick={() => setPageOffset(Math.max(0, pageOffset - PAGE_SIZE))} type="button">Anterior</button>
          <button disabled={lastRow >= dashboardPage.total} onClick={() => setPageOffset(pageOffset + PAGE_SIZE)} type="button">Próxima</button>
        </div>
      </div> : null}
    </section> : null}
  </main>;
}
