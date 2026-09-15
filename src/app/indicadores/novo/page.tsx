"use client";

import { FormEvent, useState } from "react";
import { ArrowLeft, ChartNoAxesCombined, Database, FileUp, ListTree } from "lucide-react";
import styles from "../../page.module.css";

type IndicatorRegistration = {
  code: string;
  name: string;
  dimension: string;
  definition: string;
  unit: string;
  expected_frequency: string;
};

const emptyRegistration: IndicatorRegistration = { code: "", name: "", dimension: "", definition: "", unit: "", expected_frequency: "" };

export default function NewIndicatorPage() {
  const [registration, setRegistration] = useState<IndicatorRegistration>(emptyRegistration);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");

  function updateRegistration(fieldName: keyof IndicatorRegistration, fieldValue: string) {
    setRegistration((currentRegistration) => ({ ...currentRegistration, [fieldName]: fieldValue }));
  }

  async function createIndicator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/indicators", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(registration) });
      const payload = await response.json();
      if (!response.ok) setMessage(payload.detail ?? payload.message ?? "Não foi possível cadastrar o indicador.");
      else {
        setRegistration(emptyRegistration);
        setMessage("Indicador cadastrado. Ele já está disponível nas próximas importações.");
      }
    } catch {
      setMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsSaving(false);
    }
  }

  return <div className={styles.applicationShell}>
    <aside className={styles.sidebar}><div className={styles.sidebarTop}><p className={styles.productName}>DECSYS</p><nav aria-label="Navegação principal"><a href="/"><FileUp size={20} strokeWidth={1.5} />Importações</a><a href="/dados-revisados"><Database size={20} strokeWidth={1.5} />Dados revisados</a><a className={styles.activeNav} href="/indicadores"><ListTree size={20} strokeWidth={1.5} />Indicadores</a><a href="/iiu"><ChartNoAxesCombined size={20} strokeWidth={1.5} />Índice IIU</a></nav></div></aside>
    <main className={styles.workspaceShell}>
      <a className={styles.backLink} href="/indicadores"><ArrowLeft size={16} />Voltar aos indicadores</a>
      <section className={styles.workspaceIntro}><p className={styles.eyebrow}>CATÁLOGO</p><h1>Novo indicador</h1><p>Defina o conceito que será associado aos dados importados e usado depois nos painéis.</p></section>
      <section className={styles.analysisPanel}>
        <div className={styles.sectionHeading}><div><h2>Informações do indicador</h2><span>Use códigos curtos e estáveis. Eles identificam o indicador nas consultas e dashboards.</span></div></div>
        <form className={styles.sourceForm} onSubmit={createIndicator}>
          <label>Nome<input onChange={(event) => updateRegistration("name", event.target.value)} required value={registration.name} /></label>
          <label>Código interno<input onChange={(event) => updateRegistration("code", event.target.value)} placeholder="Ex.: caged_saldo_empregos" required value={registration.code} /></label>
          <label>Dimensão<input onChange={(event) => updateRegistration("dimension", event.target.value)} placeholder="Ex.: trabalho, energia, mobilidade" required value={registration.dimension} /></label>
          <label>Definição<input onChange={(event) => updateRegistration("definition", event.target.value)} placeholder="Explique com clareza o que o valor representa." required value={registration.definition} /></label>
          <label>Unidade<input onChange={(event) => updateRegistration("unit", event.target.value)} placeholder="Ex.: pessoas, %, kW" required value={registration.unit} /></label>
          <label>Periodicidade<input onChange={(event) => updateRegistration("expected_frequency", event.target.value)} placeholder="Ex.: mensal ou anual" value={registration.expected_frequency} /></label>
          {message ? <p className={message.startsWith("Indicador cadastrado") ? styles.profileGuidance : styles.feedbackMessage}>{message}</p> : null}
          <div className={styles.formActions}><a href="/indicadores">Cancelar</a><button className={styles.primaryButton} disabled={isSaving} type="submit">{isSaving ? "Cadastrando..." : "Cadastrar indicador"}</button></div>
        </form>
      </section>
    </main>
  </div>;
}
