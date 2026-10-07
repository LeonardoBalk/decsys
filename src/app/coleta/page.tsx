"use client";

import type { Route } from "next";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Download, ExternalLink, Link2, MapPin, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import styles from "../page.module.css";
import coleta from "./coleta.module.css";
import { StatusNotice } from "../_components/status-notice";
import { SourceForm } from "../_components/coleta/fonte-form";
import { importErrorMessage } from "@/lib/import-error-message";
import { ACCESS_LABELS, CollectionAccess, CollectionDraft, CollectionEntry, CollectionItem, collectionDimensions, collectionItems, countByAccess, draftFromItem, emptyCollectionDraft, importHref, isHttpsUrl, mergeCollectionItems } from "@/lib/coleta-catalog";

type AccessFilter = CollectionAccess | "all";
type FormState = { draft: CollectionDraft; isEditing: boolean } | null;

const ACCESS_ICONS = { link: Link2, manual: Download, local: MapPin } as const;
const ORIGIN_LABELS = { custom: "Adicionada", edited: "Editada" } as const;

function ItemActions({ item, onEdit, onRemove }: { item: CollectionEntry; onEdit: () => void; onRemove: () => void }) {
  const sourceLink = item.manualUrl ?? item.officialLink;
  return <div className={coleta.actions}>
    {item.access === "link" && isHttpsUrl(item.importUrl) ? <Link className={styles.primaryLink} href={importHref(item.importUrl) as Route}>Importar no DECSYS</Link> : null}
    {isHttpsUrl(sourceLink) ? <a className={coleta.externalLink} href={sourceLink} rel="noreferrer" target="_blank"><ExternalLink size={14} />Abrir fonte</a> : null}
    <span className={coleta.spacer} />
    <button className={coleta.textButton} onClick={onEdit} type="button"><Pencil size={14} />Editar</button>
    {item.origin !== "base" ? <button className={coleta.textButton} onClick={onRemove} type="button">{item.origin === "edited" ? <><RotateCcw size={14} />Restaurar original</> : <><Trash2 size={14} />Excluir</>}</button> : null}
  </div>;
}

function ItemRow({ item, onEdit, onRemove }: { item: CollectionEntry; onEdit: () => void; onRemove: () => void }) {
  const AccessIcon = ACCESS_ICONS[item.access];
  return <li>
    <details className={coleta.item}>
      <summary className={coleta.toggle}>
        <span className={coleta.code}>{item.code}</span>
        <span><strong>{item.name}{item.origin !== "base" ? <em className={coleta.originTag}>{ORIGIN_LABELS[item.origin]}</em> : null}</strong><span className={coleta.meta}>{item.source} · {item.unit}</span></span>
        <span className={`${coleta.badge} ${coleta[`badge_${item.access}`]}`}><AccessIcon size={13} />{ACCESS_LABELS[item.access]}</span>
        <ChevronRight aria-hidden className={coleta.chevron} size={16} />
      </summary>
      <div className={coleta.body}>
        <p className={coleta.steps}>{item.steps}</p>
        {item.needs.length > 0 ? <p className={coleta.note}>Precisa também de: {item.needs.join("; ")}</p> : null}
        {item.notes ? <p className={coleta.note}>{item.notes}</p> : null}
        <ItemActions item={item} onEdit={onEdit} onRemove={onRemove} />
      </div>
    </details>
  </li>;
}

export default function CollectionPage() {
  const [accessFilter, setAccessFilter] = useState<AccessFilter>("all");
  const [search, setSearch] = useState("");
  const [savedSources, setSavedSources] = useState<CollectionItem[]>([]);
  const [loadWarning, setLoadWarning] = useState("");
  const [formState, setFormState] = useState<FormState>(null);
  const [formKey, setFormKey] = useState(0);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/collection-sources", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível carregar as fontes salvas."));
        const payload: unknown = await response.json();
        if (Array.isArray(payload)) setSavedSources(payload as CollectionItem[]);
      })
      .catch((loadError: unknown) => setLoadWarning(loadError instanceof Error ? loadError.message : "Não foi possível carregar as fontes salvas."));
  }, []);

  const items = useMemo(() => mergeCollectionItems(collectionItems, savedSources), [savedSources]);
  const totals = useMemo(() => countByAccess(items), [items]);
  const dimensions = useMemo(() => collectionDimensions(items), [items]);
  const visibleItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => (accessFilter === "all" || item.access === accessFilter) && (!term || `${item.code} ${item.name} ${item.source} ${item.factor}`.toLowerCase().includes(term)));
  }, [items, accessFilter, search]);

  function openForm(draft: CollectionDraft, isEditing: boolean) {
    setFeedback(null);
    setFormKey((current) => current + 1);
    setFormState({ draft, isEditing });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleSaved(saved: CollectionItem) {
    setSavedSources((current) => [...current.filter((item) => item.code !== saved.code), saved]);
    setFormState(null);
    setFeedback({ kind: "success", text: `${saved.code} salva.` });
  }

  async function removeSaved(item: CollectionEntry) {
    const question = item.origin === "edited" ? `Voltar ${item.code} para a versão original da matriz?` : `Excluir ${item.code} da lista?`;
    if (!window.confirm(question)) return;
    try {
      const response = await fetch(`/api/collection-sources/${encodeURIComponent(item.code)}`, { method: "DELETE" });
      if (!response.ok) {
        setFeedback({ kind: "error", text: await importErrorMessage(response, "Não foi possível remover a fonte.") });
        return;
      }
      setSavedSources((current) => current.filter((saved) => saved.code !== item.code));
      setFeedback({ kind: "success", text: item.origin === "edited" ? `${item.code} voltou à versão original.` : `${item.code} excluída.` });
    } catch {
      setFeedback({ kind: "error", text: "Não foi possível acessar o serviço de tratamento." });
    }
  }

  return <main className={styles.workspaceShell}>
    <section className={styles.workspaceIntro}>
      <p className={styles.eyebrow}>COLETA</p>
      <h1>Onde buscar cada dado da matriz</h1>
      <p>{items.length} indicadores em {dimensions.length} dimensões. {totals.link} podem ser importados direto por link, {totals.manual} exigem download manual e {totals.local} dependem de levantamento com a prefeitura.</p>
      <div className={coleta.introActions}><button className={styles.secondaryLink} onClick={() => openForm(emptyCollectionDraft, false)} type="button"><Plus size={16} />Adicionar fonte</button></div>
    </section>
    {formState ? <section className={styles.analysisPanel}><SourceForm dimensions={dimensions} initial={formState.draft} isEditing={formState.isEditing} key={formKey} onCancel={() => setFormState(null)} onSaved={handleSaved} /></section> : null}
    {feedback ? <StatusNotice variant={feedback.kind}>{feedback.text}</StatusNotice> : null}
    {loadWarning ? <StatusNotice variant="warning">{loadWarning} A lista abaixo mostra só a matriz original; fontes que você adicionar não poderão ser salvas até isso ser resolvido.</StatusNotice> : null}
    <section className={coleta.legend} aria-label="Como ler esta lista">
      <div><span className={`${coleta.badge} ${coleta.badge_link}`}><Link2 size={13} />{ACCESS_LABELS.link}</span><p>O botão leva à importação já com o link preenchido. Fontes grandes podem pedir para escolher a aba ou o arquivo certo.</p></div>
      <div><span className={`${coleta.badge} ${coleta.badge_manual}`}><Download size={13} />{ACCESS_LABELS.manual}</span><p>O dado é público, mas exige navegador ou passa de 200 MB. Baixe pelo passo a passo e envie o arquivo na importação.</p></div>
      <div><span className={`${coleta.badge} ${coleta.badge_local}`}><MapPin size={13} />{ACCESS_LABELS.local}</span><p>Não há base nacional por município. É preciso pedir o dado à prefeitura ou fazer um levantamento.</p></div>
    </section>
    <section className={styles.analysisPanel}>
      <div className={coleta.filters}>
        {(["all", "link", "manual", "local"] as const).map((option) => <button aria-pressed={accessFilter === option} className={accessFilter === option ? coleta.filterActive : undefined} key={option} onClick={() => setAccessFilter(option)} type="button">{option === "all" ? `Todos (${items.length})` : `${ACCESS_LABELS[option]} (${totals[option]})`}</button>)}
        <input aria-label="Buscar indicador" onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por código, nome ou fonte" type="search" value={search} />
      </div>
      {collectionDimensions(visibleItems).map((dimension) => <div key={dimension}>
        <h2 className={coleta.dimension}>{dimension}</h2>
        <ul className={coleta.list}>{visibleItems.filter((item) => item.dimension === dimension).map((item) => <ItemRow item={item} key={item.code} onEdit={() => openForm(draftFromItem(item), true)} onRemove={() => void removeSaved(item)} />)}</ul>
      </div>)}
      {visibleItems.length === 0 ? <p className={styles.fieldNote}>Nenhum indicador encontrado para esse filtro.</p> : null}
    </section>
  </main>;
}
