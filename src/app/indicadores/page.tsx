"use client";

import { FormEvent, useEffect, useState } from "react";
import { Database, FileUp, Link2, ListTree } from "lucide-react";
import styles from "../page.module.css";
import { Indicator } from "@/lib/types/importacao";

type IndicatorRegistration = {
  code: string;
  name: string;
  dimension: string;
  definition: string;
  unit: string;
  expected_frequency: string;
};

const emptyRegistration: IndicatorRegistration = { code: "", name: "", dimension: "", definition: "", unit: "", expected_frequency: "" };

export default function IndicatorsPage() {
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [registration, setRegistration] = useState<IndicatorRegistration>(emptyRegistration);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function loadIndicators() {
    setIsLoading(true);
    try {
      const response = await fetch("/api/indicators");
      const payload = await response.json();
      if (!response.ok) setMessage(payload.detail ?? payload.message ?? "Não foi possível carregar os indicadores.");
      else setIndicators(payload);
    } catch {
      setMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => { void loadIndicators(); }, []);

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
        setIndicators((currentIndicators) => [...currentIndicators, payload].sort((firstIndicator, secondIndicator) => firstIndicator.name.localeCompare(secondIndicator.name)));
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
    <aside className={styles.sidebar}>
      <div className={styles.sidebarTop}>
        <p className={styles.productName}>DECSYS</p>
        <nav aria-label="Navegação principal">
          <a href="/"><FileUp size={20} strokeWidth={1.5} />Importações</a>
          <a href="/dados-revisados"><Database size={20} strokeWidth={1.5} />Dados revisados</a>
          <a className={styles.activeNav} href="/indicadores"><ListTree size={20} strokeWidth={1.5} />Indicadores</a>
          <a href="/#fontes"><Link2 size={20} strokeWidth={1.5} />Fontes</a>
        </nav>
      </div>
    </aside>
    <main className={styles.workspaceShell}>
      <section className={styles.workspaceIntro}>
        <p className={styles.eyebrow}>CATÁLOGO</p>
        <h1>Indicadores</h1>
        <p>Cadastre e mantenha os conceitos usados nas importações. Cada indicador define o que o valor mede, sua unidade e periodicidade.</p>
      </section>
      <section className={styles.analysisPanel}>
        <div className={styles.sectionHeading}><div><h2>Novo indicador</h2><span>Use códigos curtos e estáveis. Eles identificam o indicador nas consultas e dashboards.</span></div></div>
        <form className={styles.sourceForm} onSubmit={createIndicator}>
          <label>Nome<input onChange={(event) => updateRegistration("name", event.target.value)} required value={registration.name} /></label>
          <label>Código interno<input onChange={(event) => updateRegistration("code", event.target.value)} placeholder="Ex.: caged_saldo_empregos" required value={registration.code} /></label>
          <label>Dimensão<input onChange={(event) => updateRegistration("dimension", event.target.value)} placeholder="Ex.: trabalho, energia, mobilidade" required value={registration.dimension} /></label>
          <label>Definição<input onChange={(event) => updateRegistration("definition", event.target.value)} placeholder="Explique com clareza o que o valor representa." required value={registration.definition} /></label>
          <label>Unidade<input onChange={(event) => updateRegistration("unit", event.target.value)} placeholder="Ex.: pessoas, %, kW" required value={registration.unit} /></label>
          <label>Periodicidade<input onChange={(event) => updateRegistration("expected_frequency", event.target.value)} placeholder="Ex.: mensal ou anual" value={registration.expected_frequency} /></label>
          {message ? <p className={message.startsWith("Indicador cadastrado") ? styles.profileGuidance : styles.feedbackMessage}>{message}</p> : null}
          <button className={styles.primaryButton} disabled={isSaving} type="submit">{isSaving ? "Cadastrando..." : "Cadastrar indicador"}</button>
        </form>
      </section>
      <section className={styles.tableWorkspace}>
        <div className={styles.tableHeading}><div><p className={styles.eyebrow}>CADASTRADOS</p><h2>Indicadores disponíveis</h2></div><span>{indicators.length.toLocaleString("pt-BR")} indicadores</span></div>
        {isLoading ? <p className={styles.loadingNotice}>Carregando catálogo.</p> : null}
        {!isLoading && indicators.length ? <div className={styles.tableWrap}><table><thead><tr><th>Nome</th><th>Código</th><th>Unidade</th></tr></thead><tbody>{indicators.map((indicator) => <tr key={indicator.id}><td>{indicator.name}</td><td>{indicator.code}</td><td>{indicator.unit}</td></tr>)}</tbody></table></div> : null}
        {!isLoading && !indicators.length ? <p className={styles.profileGuidance}>Ainda não há indicadores cadastrados. Crie o primeiro para poder aprovar dados municipais.</p> : null}
      </section>
    </main>
  </div>;
}
