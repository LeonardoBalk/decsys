"use client";

import { useEffect, useMemo, useState } from "react";
import { Database, FileUp, Link2, RefreshCw } from "lucide-react";
import styles from "../page.module.css";

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
};

function formatValue(value: DashboardValue["value"]) {
  if (value === null) return "—";
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(Number(value));
}

export default function ReviewedDataPage() {
  const [dashboardValues, setDashboardValues] = useState<DashboardValue[]>([]);
  const [selectedIndicator, setSelectedIndicator] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");

  async function loadDashboardValues() {
    setIsLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/dashboard-values");
      const payload = await response.json();
      if (!response.ok) setMessage(payload.detail ?? payload.message ?? "Não foi possível carregar os dados revisados.");
      else setDashboardValues(payload);
    } catch {
      setMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => { void loadDashboardValues(); }, []);

  const indicators = useMemo(() => Array.from(new Map(dashboardValues.map((dashboardValue) => [dashboardValue.indicator_code, dashboardValue.indicator_name])).entries()), [dashboardValues]);
  const visibleValues = selectedIndicator ? dashboardValues.filter((dashboardValue) => dashboardValue.indicator_code === selectedIndicator) : dashboardValues;
  const periodRange = visibleValues.length ? `${new Date(visibleValues.at(-1)!.reference_period).getFullYear()}–${new Date(visibleValues[0].reference_period).getFullYear()}` : "—";

  return <div className={styles.applicationShell}>
    <aside className={styles.sidebar}>
      <div className={styles.sidebarTop}>
        <p className={styles.productName}>DECSYS</p>
        <nav aria-label="Navegação principal">
          <a href="/"><FileUp size={20} strokeWidth={1.5} />Importações</a>
          <a className={styles.activeNav} href="/dados-revisados"><Database size={20} strokeWidth={1.5} />Dados revisados</a>
          <a href="/#fontes"><Link2 size={20} strokeWidth={1.5} />Fontes</a>
        </nav>
      </div>
    </aside>
    <main className={styles.workspaceShell}>
      <section className={styles.workspaceIntro}>
        <p className={styles.eyebrow}>CONFERÊNCIA</p>
        <h1>Dados revisados</h1>
        <p>Confira somente valores aprovados. O arquivo original e a fonte continuam vinculados a cada registro para facilitar a auditoria.</p>
      </section>
      <section className={styles.analysisPanel}>
        <div className={styles.sectionHeading}><div><h2>Visão geral</h2><span>Esta tela não inclui rascunhos nem importações descartadas.</span></div><button disabled={isLoading} onClick={() => void loadDashboardValues()} type="button"><RefreshCw size={16} />Atualizar</button></div>
        <div className={styles.profileSummary}><dl><div><dt>Registros visíveis</dt><dd>{visibleValues.length.toLocaleString("pt-BR")}</dd></div><div><dt>Indicadores</dt><dd>{new Set(visibleValues.map((dashboardValue) => dashboardValue.indicator_code)).size}</dd></div><div><dt>Período</dt><dd>{periodRange}</dd></div><div><dt>Fontes</dt><dd>{new Set(visibleValues.map((dashboardValue) => dashboardValue.source_name)).size}</dd></div></dl></div>
      </section>
      <section className={styles.analysisPanel}>
        <div className={styles.sectionHeading}><div><h2>Filtrar a conferência</h2><span>Indicadores com unidades diferentes permanecem separados.</span></div></div>
        <div className={styles.sourceForm}><label>Indicador<select onChange={(event) => setSelectedIndicator(event.target.value)} value={selectedIndicator}><option value="">Todos os indicadores</option>{indicators.map(([indicatorCode, indicatorName]) => <option key={indicatorCode} value={indicatorCode}>{indicatorName}</option>)}</select></label></div>
      </section>
      {isLoading ? <p className={styles.loadingNotice}>Carregando valores aprovados.</p> : null}
      {message ? <p className={styles.feedbackMessage}>{message}</p> : null}
      {!isLoading && !message ? <section className={styles.tableWorkspace}><div className={styles.tableHeading}><div><p className={styles.eyebrow}>VALORES PUBLICADOS</p><h2>Conferência por registro</h2></div><span>{visibleValues.length.toLocaleString("pt-BR")} registros</span></div>{visibleValues.length ? <div className={styles.tableWrap}><table><thead><tr><th>Indicador</th><th>Período</th><th>Valor</th><th>Município</th><th>Fonte</th><th>Importação</th></tr></thead><tbody>{visibleValues.map((dashboardValue) => <tr key={dashboardValue.id}><td>{dashboardValue.indicator_name}</td><td>{new Date(`${dashboardValue.reference_period}T12:00:00`).toLocaleDateString("pt-BR", { month: "short", year: "numeric" })}</td><td>{formatValue(dashboardValue.value)} {dashboardValue.unit}</td><td>{dashboardValue.dimensions.municipality_ibge_code ?? "—"}</td><td>{dashboardValue.source_name}</td><td>{dashboardValue.import_title}</td></tr>)}</tbody></table></div> : <p className={styles.profileGuidance}>Ainda não há valores aprovados. Salve uma importação, revise as colunas e aprove o indicador para ela aparecer aqui.</p>}</section> : null}
    </main>
  </div>;
}
