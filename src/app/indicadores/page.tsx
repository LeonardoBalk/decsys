"use client";

import { useEffect, useState } from "react";
import { ChartNoAxesCombined, Database, FileUp, ListTree, Plus } from "lucide-react";
import styles from "../page.module.css";
import { Indicator } from "@/lib/types/importacao";
import { StatusNotice } from "../_components/status-notice";

export default function IndicatorsPage() {
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  async function loadIndicators() {
    setIsLoading(true);
    setLoadError("");
    try {
      const response = await fetch("/api/indicators");
      const payload = await response.json();
      if (!response.ok) setLoadError(payload.detail ?? payload.message ?? "Não foi possível carregar os indicadores.");
      else if (!Array.isArray(payload)) setLoadError("A lista recebida está em um formato inesperado.");
      else setIndicators(payload);
    } catch {
      setLoadError("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => { void loadIndicators(); }, []);

  return <div className={styles.applicationShell}>
    <aside className={styles.sidebar}>
      <div className={styles.sidebarTop}>
        <p className={styles.productName}>DECSYS</p>
        <nav aria-label="Navegação principal">
          <a href="/"><FileUp size={20} strokeWidth={1.5} />Importações</a>
          <a href="/dados-revisados"><Database size={20} strokeWidth={1.5} />Dados revisados</a>
          <a className={styles.activeNav} href="/indicadores"><ListTree size={20} strokeWidth={1.5} />Indicadores</a>
          <a href="/iiu"><ChartNoAxesCombined size={20} strokeWidth={1.5} />Índice IIU</a>
        </nav>
      </div>
    </aside>
    <main className={styles.workspaceShell}>
      <section className={styles.workspaceIntro}>
        <p className={styles.eyebrow}>CATÁLOGO</p>
        <h1>Indicadores</h1>
        <p>Cadastre e mantenha os conceitos usados nas importações. Cada indicador define o que o valor mede, sua unidade e periodicidade.</p>
      </section>
      <section className={styles.tableWorkspace}>
        <div className={styles.tableHeading}><div><p className={styles.eyebrow}>CADASTRADOS</p><h2>Indicadores disponíveis</h2></div><a className={styles.primaryLink} href="/indicadores/novo"><Plus size={16} />Criar novo indicador</a></div>
        {isLoading ? <StatusNotice variant="loading">Carregando o catálogo de indicadores.</StatusNotice> : null}
        {!isLoading && loadError ? <StatusNotice action={{ label: "Tentar novamente", onClick: () => void loadIndicators() }} variant="error">{loadError}</StatusNotice> : null}
        {!isLoading && !loadError && indicators.length ? <div className={styles.tableWrap}><table><thead><tr><th>Nome</th><th>Código</th><th>Unidade</th></tr></thead><tbody>{indicators.map((indicator) => <tr key={indicator.id}><td>{indicator.name}</td><td>{indicator.code}</td><td>{indicator.unit}</td></tr>)}</tbody></table></div> : null}
        {!isLoading && !loadError && !indicators.length ? <p className={styles.profileGuidance}>Ainda não há indicadores cadastrados. Use o botão acima para criar o primeiro.</p> : null}
      </section>
    </main>
  </div>;
}
