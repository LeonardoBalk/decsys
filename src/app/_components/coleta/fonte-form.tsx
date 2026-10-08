"use client";

import { FormEvent, useState } from "react";
import styles from "../../page.module.css";
import { StatusNotice } from "../status-notice";
import { importErrorMessage } from "@/lib/import-error-message";
import { CollectionDraft, CollectionItem, payloadFromDraft } from "@/lib/coleta-catalog";

type SourceFormProps = {
  initial: CollectionDraft;
  isEditing: boolean;
  dimensions: string[];
  onCancel: () => void;
  onSaved: (item: CollectionItem) => void;
};

export function SourceForm({ initial, isEditing, dimensions, onCancel, onSaved }: SourceFormProps) {
  const [draft, setDraft] = useState(initial);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  function update<Field extends keyof CollectionDraft>(field: Field, value: CollectionDraft[Field]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError("");
    try {
      const code = draft.code.trim().toUpperCase() || `FONTE_${Date.now().toString(36).toUpperCase()}`;
      const response = await fetch(`/api/collection-sources/${encodeURIComponent(code)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payloadFromDraft(draft)) });
      if (!response.ok) setError(await importErrorMessage(response, "Não foi possível salvar a fonte."));
      else onSaved((await response.json()) as CollectionItem);
    } catch {
      setError("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsSaving(false);
    }
  }

  return <form className={styles.sourceForm} onSubmit={submit}>
    <div className={styles.sectionHeading}><div><h2>{isEditing ? `Editar ${draft.code}` : "Adicionar fonte de coleta"}</h2><span>{isEditing ? "Se este indicador vem da matriz, a sua versão passa a valer no lugar da original; dá para restaurar depois." : "A fonte aparece na lista junto com os indicadores da matriz."}</span></div></div>
    <p className={styles.fieldNote}>Todos os campos são opcionais. Sem sigla, o sistema cria uma; sem dimensão, a fonte vai para “Outras”; sem nome, usa a sigla.</p>
    <label>Sigla<input disabled={isEditing} onChange={(event) => update("code", event.target.value.toUpperCase())} pattern="[A-Za-z0-9_]{2,30}" placeholder="Ex.: ECO11" value={draft.code} /></label>
    <label>Dimensão<input list="collection-dimensions" onChange={(event) => update("dimension", event.target.value)} placeholder="Ex.: Economia" value={draft.dimension} /><datalist id="collection-dimensions">{dimensions.map((dimension) => <option key={dimension} value={dimension} />)}</datalist></label>
    <label>Fator<input onChange={(event) => update("factor", event.target.value)} placeholder="Ex.: Produtividade" value={draft.factor} /></label>
    <label>Nome do indicador<input onChange={(event) => update("name", event.target.value)} value={draft.name} /></label>
    <label>Definição<textarea onChange={(event) => update("definition", event.target.value)} placeholder="Como o valor é calculado." rows={3} value={draft.definition} /></label>
    <label>Unidade<input onChange={(event) => update("unit", event.target.value)} placeholder="Ex.: %, R$/hab." value={draft.unit} /></label>
    <label>Fonte<input onChange={(event) => update("source", event.target.value)} placeholder="Ex.: IBGE — SIDRA" value={draft.source} /></label>
    <label>Como coletar<select onChange={(event) => update("access", event.target.value as CollectionDraft["access"])} value={draft.access}><option value="link">Importar por link</option><option value="manual">Baixar manualmente</option><option value="local">Levantamento local (prefeitura)</option></select></label>
    {draft.access === "link" ? <label>Link para importar<input onChange={(event) => update("importUrl", event.target.value)} placeholder="https://..." type="url" value={draft.importUrl} /><span className={styles.fieldNote}>Opcional. Se preencher, precisa ser HTTPS e abrir direto uma tabela (CSV, XLSX, JSON ou ZIP) ou uma página com os arquivos; só então aparece o botão de importar.</span></label> : null}
    <label>Página da fonte<input onChange={(event) => update("manualUrl", event.target.value)} placeholder="https://..." type="url" value={draft.manualUrl} /></label>
    <label>Passo a passo<textarea onChange={(event) => update("steps", event.target.value)} placeholder="O que fazer, em frases curtas: tabela, filtros, aba do arquivo." rows={3} value={draft.steps} /></label>
    <label>Precisa também de<input onChange={(event) => update("needs", event.target.value)} placeholder="Separe por ponto e vírgula. Ex.: população por município; área" value={draft.needs} /></label>
    <label>Observações<textarea onChange={(event) => update("notes", event.target.value)} placeholder="Ano mais recente, limites, avisos." rows={2} value={draft.notes} /></label>
    {error ? <StatusNotice variant="error">{error}</StatusNotice> : null}
    <div className={styles.formActions}><button disabled={isSaving} onClick={onCancel} type="button">Cancelar</button><button className={styles.primaryButton} disabled={isSaving} type="submit">{isSaving ? "Salvando..." : "Salvar fonte"}</button></div>
  </form>;
}
