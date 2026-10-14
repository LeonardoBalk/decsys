"use client";

import type { Route } from "next";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, GitCompareArrows, RefreshCw } from "lucide-react";
import styles from "../../page.module.css";
import panels from "../../_components/iiu/paineis.module.css";
import { StatusNotice } from "../../_components/status-notice";
import { importErrorMessage } from "@/lib/import-error-message";
import { downloadCsv, csvFileName } from "@/lib/csv";
import { defaultRankingSort, nextSort, rankingQueryString, rankingToCsv, type RankingSort } from "@/lib/iiu-ranking";
import { maxCompared } from "@/lib/iiu-compare";
import type { IiuCityProfile, IiuDimensionMeta, IiuRankingPage } from "@/lib/types/iiu-paineis";

const PAGE_SIZE = 50;
const EXPORT_PAGE_SIZE = 1000;

const cityProfiles: { value: IiuCityProfile; label: string }[] = [
  { value: "pequeno", label: "Pequeno - até 50 mil habitantes" },
  { value: "medio", label: "Médio - 50 a 300 mil habitantes" },
  { value: "grande", label: "Grande - 300 mil a 1 milhão" },
  { value: "metropole", label: "Metrópole - acima de 1 milhão" },
];

function formatScore(score: number | null | undefined) {
  return score === null || score === undefined ? "-" : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(score);
}

function formatTime(isoText: string) {
  const date = new Date(isoText);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function SortIcon({ active, direction }: { active: boolean; direction: RankingSort["direction"] }) {
  if (!active) return <ArrowUpDown aria-hidden size={13} />;
  return direction === "asc" ? <ArrowUp aria-hidden size={13} /> : <ArrowDown aria-hidden size={13} />;
}

export default function IiuRankingPage() {
  const [cityProfile, setCityProfile] = useState<IiuCityProfile>("medio");
  const [dimension, setDimension] = useState("");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<RankingSort>(defaultRankingSort);
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState({ count: 0, refresh: false });
  const [ranking, setRanking] = useState<IiuRankingPage | null>(null);
  const [knownDimensions, setKnownDimensions] = useState<IiuDimensionMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<{ code: string; name: string }[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(searchText); setOffset(0); }, 300);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setMessage("");
    const query = rankingQueryString({ cityProfile, dimension, search, sort, limit: PAGE_SIZE, offset, refresh: reload.refresh });
    fetch(`/api/iiu-ranking?${query}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível montar o ranking."));
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== "object" || !Array.isArray((payload as IiuRankingPage).items)) throw new Error("O ranking veio em um formato inesperado.");
        return payload as IiuRankingPage;
      })
      .then((payload) => { if (!cancelled) { setRanking(payload); setKnownDimensions(payload.dimensions); } })
      .catch((loadError: unknown) => { if (!cancelled) setMessage(loadError instanceof Error ? loadError.message : "Não foi possível acessar o serviço de tratamento."); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [cityProfile, dimension, search, sort, offset, reload]);

  function changeProfile(profile: IiuCityProfile) {
    setCityProfile(profile);
    setDimension("");
    setSort(defaultRankingSort);
    setOffset(0);
    setSelected([]);
  }

  function changeDimension(code: string) {
    setDimension(code);
    setSort(defaultRankingSort);
    setOffset(0);
  }

  function changeSort(key: string) {
    setSort((current) => nextSort(current, key));
    setOffset(0);
  }

  function toggleSelected(code: string, name: string) {
    setSelected((current) => current.some((item) => item.code === code) ? current.filter((item) => item.code !== code) : current.length >= maxCompared ? current : [...current, { code, name }]);
  }

  async function exportCsv() {
    setIsExporting(true);
    setMessage("");
    try {
      const items: IiuRankingPage["items"] = [];
      let total = 0;
      let latest: IiuRankingPage | null = null;
      do {
        const query = rankingQueryString({ cityProfile, dimension, search, sort, limit: EXPORT_PAGE_SIZE, offset: items.length });
        const response = await fetch(`/api/iiu-ranking?${query}`, { cache: "no-store" });
        if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível exportar o ranking."));
        latest = await response.json() as IiuRankingPage;
        total = latest.total;
        if (!latest.items.length) break;
        items.push(...latest.items);
      } while (items.length < total);
      const dimensions = latest?.dimensions ?? knownDimensions;
      const selectedDimension = dimensions.find((candidate) => candidate.code === dimension);
      downloadCsv(csvFileName("ranking-iiu", cityProfile, selectedDimension?.name), rankingToCsv(items, dimensions, selectedDimension));
    } catch (exportError) {
      setMessage(exportError instanceof Error ? exportError.message : "Não foi possível exportar o ranking.");
    } finally {
      setIsExporting(false);
    }
  }

  const dimensions = ranking?.dimensions ?? knownDimensions;
  const selectedDimension = dimensions.find((candidate) => candidate.code === dimension);
  const items = ranking?.items ?? [];
  const total = ranking?.total ?? 0;
  const firstRow = total ? offset + 1 : 0;
  const lastRow = offset + items.length;
  const compareLink = useMemo(() => `/iiu/comparar?codigos=${selected.map((item) => item.code).join(",")}&porte=${cityProfile}` as Route, [selected, cityProfile]);
  const sortLabel = (key: string, label: string) => {
    const active = sort.key === key;
    return <th aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"} className={["score", "coverage"].includes(key) || dimensions.some((candidate) => candidate.code === key) ? panels.numeric : undefined} scope="col"><button className={`${panels.sortButton} ${active ? panels.sortActive : ""}`} onClick={() => changeSort(key)} type="button">{label}<SortIcon active={active} direction={sort.direction} /></button></th>;
  };

  return <main className={styles.workspaceShell}>
    <section className={styles.workspaceIntro}>
      <p className={styles.eyebrow}>ÍNDICE DE INTELIGÊNCIA URBANA</p>
      <h1>Ranking de municípios</h1>
      <p>Todos os municípios com dados aprovados, pontuados com a mesma fórmula do diagnóstico individual. Compare por porte, por dimensão ou procure uma cidade.</p>
    </section>
    <section className={styles.analysisPanel}>
      <div className={styles.sectionHeading}><div><h2>Filtros</h2><span>O ranking só compara municípios do mesmo porte, porque os pesos das dimensões mudam com o porte.</span></div></div>
      <div className={`${styles.sourceForm} ${panels.controls}`} style={{ marginTop: "var(--space-4)" }}>
        <label>Porte do município<select onChange={(event) => changeProfile(event.target.value as IiuCityProfile)} value={cityProfile}>{cityProfiles.map((profile) => <option key={profile.value} value={profile.value}>{profile.label}</option>)}</select></label>
        <label>Ordenar a posição por<select disabled={!dimensions.length} onChange={(event) => changeDimension(event.target.value)} value={dimension}><option value="">Nota geral</option>{dimensions.map((candidate) => <option key={candidate.code} value={candidate.code}>{candidate.name}</option>)}</select></label>
        <label>Buscar município<input onChange={(event) => setSearchText(event.target.value)} placeholder="Nome, UF ou código IBGE" type="search" value={searchText} /></label>
      </div>
      <div className={panels.controlsActions}>
        <button disabled={isLoading} onClick={() => setReload((current) => ({ count: current.count + 1, refresh: true }))} type="button"><RefreshCw size={16} />Recalcular</button>
        <button disabled={isExporting || isLoading || !total} onClick={() => void exportCsv()} type="button"><Download size={16} />{isExporting ? "Exportando..." : "Exportar CSV"}</button>
      </div>
    </section>
    {isLoading ? <StatusNotice variant="loading">{ranking ? "Atualizando o ranking." : "Calculando o ranking de todos os municípios. Na primeira vez pode levar alguns instantes."}</StatusNotice> : null}
    {message ? <StatusNotice action={{ label: "Tentar novamente", onClick: () => setReload((current) => ({ count: current.count + 1, refresh: false })) }} variant="error">{message}</StatusNotice> : null}
    {ranking && !message ? <>
      {ranking.truncated ? <StatusNotice variant="warning" title="Ranking parcial">Havia valores demais para ler de uma vez. Foram usados os mais recentes; alguns municípios podem estar sem os dados mais antigos.</StatusNotice> : null}
      <section className={styles.tableWorkspace} style={{ marginTop: "var(--space-4)" }}>
        <div className={styles.tableHeading}>
          <div><p className={styles.eyebrow}>{selectedDimension ? selectedDimension.name.toUpperCase() : "NOTA GERAL"}</p><h2>{ranking.scored_municipalities.toLocaleString("pt-BR")} municípios com nota</h2></div>
          <span>{firstRow.toLocaleString("pt-BR")}–{lastRow.toLocaleString("pt-BR")} de {total.toLocaleString("pt-BR")} · calculado às {formatTime(ranking.generated_at)}{ranking.cached ? " (guardado)" : ""}</span>
        </div>
        {selected.length ? <div className={panels.selectionBar}>
          <span>{selected.length} de {maxCompared} selecionados: {selected.map((item) => item.name).join(", ")}</span>
          <div>
            <button onClick={() => setSelected([])} type="button">Limpar</button>
            {selected.length >= 2 ? <Link className={styles.secondaryLink} href={compareLink}><GitCompareArrows size={16} />Comparar</Link> : <span>Escolha ao menos mais um.</span>}
          </div>
        </div> : null}
        {items.length ? <div className={styles.tableWrap}>
          <table className={panels.rankTable}>
            <thead><tr>
              <th className={panels.checkCell} scope="col"><span className={panels.visuallyHidden}>Selecionar para comparar</span></th>
              <th scope="col">Posição</th>
              {sortLabel("name", "Município")}
              {sortLabel("state", "UF")}
              {sortLabel("score", selectedDimension ? selectedDimension.name : "Nota geral")}
              {dimension ? null : dimensions.map((candidate) => <Fragment key={candidate.code}>{sortLabel(candidate.code, candidate.name)}</Fragment>)}
              {sortLabel("coverage", "Indicadores")}
              <th scope="col"><span className={panels.visuallyHidden}>Evolução</span></th>
            </tr></thead>
            <tbody>{items.map((item) => {
              const isSelected = selected.some((entry) => entry.code === item.municipality_ibge_code);
              return <tr key={item.municipality_ibge_code}>
                <td className={panels.checkCell}><input aria-label={`Comparar ${item.name}`} checked={isSelected} disabled={!isSelected && selected.length >= maxCompared} onChange={() => toggleSelected(item.municipality_ibge_code, item.name)} type="checkbox" /></td>
                <td className={panels.positionCell}>{item.rank}º</td>
                <td className={panels.municipalityCell}><strong>{item.name}</strong><span>{item.municipality_ibge_code}</span></td>
                <td>{item.state ?? "-"}</td>
                <td className={panels.numeric}><span className={panels.scoreMeter}><span className={panels.barTrack}><i className={panels.barFill} style={{ background: selectedDimension?.color ?? "#3987e5", width: `${Math.max(0, Math.min(100, item.score))}%` }} /></span><strong>{formatScore(item.score)}</strong></span></td>
                {dimension ? null : dimensions.map((candidate) => <td className={panels.numeric} key={candidate.code}>{formatScore(item.dimension_scores[candidate.code])}</td>)}
                <td className={panels.numeric} title={`${item.observed_indicators} com valor, ${item.scored_indicators} com nota, de ${ranking.total_indicators}`}>{item.scored_indicators}/{ranking.total_indicators}</td>
                <td><Link href={`/iiu/evolucao?municipio=${item.municipality_ibge_code}` as Route}>Evolução</Link></td>
              </tr>;
            })}</tbody>
          </table>
        </div> : <p className={styles.profileGuidance}>{search ? "Nenhum município encontrado para esta busca." : "Nenhum município tem nota para este porte ainda. Aprove importações e confirme se os benchmarks do porte estão configurados."}</p>}
        {total > PAGE_SIZE ? <div className={styles.pagination}>
          <span>Página {Math.floor(offset / PAGE_SIZE) + 1} de {Math.ceil(total / PAGE_SIZE)}</span>
          <div>
            <button disabled={offset === 0 || isLoading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} type="button">Anterior</button>
            <button disabled={lastRow >= total || isLoading} onClick={() => setOffset(offset + PAGE_SIZE)} type="button">Próxima</button>
          </div>
        </div> : null}
      </section>
    </> : null}
  </main>;
}
