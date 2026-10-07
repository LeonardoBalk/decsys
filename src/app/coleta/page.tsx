"use client";

import type { Route } from "next";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronRight, Download, ExternalLink, Link2, MapPin } from "lucide-react";
import styles from "../page.module.css";
import coleta from "./coleta.module.css";
import { ACCESS_LABELS, CollectionAccess, CollectionItem, collectionDimensions, collectionItems, countByAccess, importHref, isHttpsUrl } from "@/lib/coleta-catalog";

type AccessFilter = CollectionAccess | "all";

const ACCESS_ICONS = { link: Link2, manual: Download, local: MapPin } as const;

function ItemActions({ item }: { item: CollectionItem }) {
  const sourceLink = item.manualUrl ?? item.officialLink;
  return <div className={coleta.actions}>
    {item.access === "link" && isHttpsUrl(item.importUrl) ? <Link className={styles.primaryLink} href={importHref(item.importUrl) as Route}>Importar no DECSYS</Link> : null}
    {isHttpsUrl(sourceLink) ? <a className={coleta.externalLink} href={sourceLink} rel="noreferrer" target="_blank"><ExternalLink size={14} />Abrir fonte</a> : null}
  </div>;
}

function ItemRow({ item }: { item: CollectionItem }) {
  const AccessIcon = ACCESS_ICONS[item.access];
  return <li>
    <details className={coleta.item}>
      <summary className={coleta.toggle}>
        <span className={coleta.code}>{item.code}</span>
        <span><strong>{item.name}</strong><span className={coleta.meta}>{item.source} · {item.unit}</span></span>
        <span className={`${coleta.badge} ${coleta[`badge_${item.access}`]}`}><AccessIcon size={13} />{ACCESS_LABELS[item.access]}</span>
        <ChevronRight aria-hidden className={coleta.chevron} size={16} />
      </summary>
      <div className={coleta.body}>
        <p className={coleta.steps}>{item.steps}</p>
        {item.needs.length > 0 ? <p className={coleta.note}>Precisa também de: {item.needs.join("; ")}</p> : null}
        {item.notes ? <p className={coleta.note}>{item.notes}</p> : null}
        <ItemActions item={item} />
      </div>
    </details>
  </li>;
}

export default function CollectionPage() {
  const [accessFilter, setAccessFilter] = useState<AccessFilter>("all");
  const [search, setSearch] = useState("");
  const totals = useMemo(() => countByAccess(), []);
  const visibleItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return collectionItems.filter((item) => (accessFilter === "all" || item.access === accessFilter) && (!term || `${item.code} ${item.name} ${item.source} ${item.factor}`.toLowerCase().includes(term)));
  }, [accessFilter, search]);

  return <main className={styles.workspaceShell}>
    <section className={styles.workspaceIntro}>
      <p className={styles.eyebrow}>COLETA</p>
      <h1>Onde buscar cada dado da matriz</h1>
      <p>{collectionItems.length} indicadores em {collectionDimensions().length} dimensões. {totals.link} podem ser importados direto por link, {totals.manual} exigem download manual e {totals.local} dependem de levantamento com a prefeitura.</p>
    </section>
    <section className={coleta.legend} aria-label="Como ler esta lista">
      <div><span className={`${coleta.badge} ${coleta.badge_link}`}><Link2 size={13} />{ACCESS_LABELS.link}</span><p>O botão leva à importação já com o link preenchido. Fontes grandes podem pedir para escolher a aba ou o arquivo certo.</p></div>
      <div><span className={`${coleta.badge} ${coleta.badge_manual}`}><Download size={13} />{ACCESS_LABELS.manual}</span><p>O dado é público, mas exige navegador ou passa de 200 MB. Baixe pelo passo a passo e envie o arquivo na importação.</p></div>
      <div><span className={`${coleta.badge} ${coleta.badge_local}`}><MapPin size={13} />{ACCESS_LABELS.local}</span><p>Não há base nacional por município. É preciso pedir o dado à prefeitura ou fazer um levantamento.</p></div>
    </section>
    <section className={styles.analysisPanel}>
      <div className={coleta.filters}>
        {(["all", "link", "manual", "local"] as const).map((option) => <button aria-pressed={accessFilter === option} className={accessFilter === option ? coleta.filterActive : undefined} key={option} onClick={() => setAccessFilter(option)} type="button">{option === "all" ? `Todos (${collectionItems.length})` : `${ACCESS_LABELS[option]} (${totals[option]})`}</button>)}
        <input aria-label="Buscar indicador" onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por código, nome ou fonte" type="search" value={search} />
      </div>
      {collectionDimensions(visibleItems).map((dimension) => <div key={dimension}>
        <h2 className={coleta.dimension}>{dimension}</h2>
        <ul className={coleta.list}>{visibleItems.filter((item) => item.dimension === dimension).map((item) => <ItemRow item={item} key={item.code} />)}</ul>
      </div>)}
      {visibleItems.length === 0 ? <p className={styles.fieldNote}>Nenhum indicador encontrado para esse filtro.</p> : null}
    </section>
  </main>;
}
