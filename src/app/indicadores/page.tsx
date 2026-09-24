"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import styles from "../page.module.css";
import { Indicator } from "@/lib/types/importacao";
import { StatusNotice } from "../_components/status-notice";
import { importErrorMessage } from "@/lib/import-error-message";

export default function IndicatorsPage() {
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionMessageKind, setActionMessageKind] = useState<"error" | "success">("success");
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);

  async function loadIndicators() {
    setIsLoading(true);
    setLoadError("");
    try {
      const response = await fetch("/api/indicators", { cache: "no-store" });
      if (!response.ok) setLoadError(await importErrorMessage(response, "Não foi possível carregar os indicadores."));
      else {
        const payload: unknown = await response.json();
        if (!Array.isArray(payload)) setLoadError("A lista recebida está em um formato inesperado.");
        else setIndicators(payload as Indicator[]);
      }
    } catch {
      setLoadError("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => { void loadIndicators(); }, []);

  async function deactivateIndicator(indicator: Indicator) {
    if (!window.confirm(`Desativar "${indicator.name}"? Ele deixa de aparecer nas novas importações, mas os valores já publicados continuam nos painéis.`)) return;
    setDeactivatingId(indicator.id);
    setActionMessage("");
    try {
      const response = await fetch(`/api/indicators/${encodeURIComponent(indicator.id)}/deactivate`, { method: "POST" });
      if (!response.ok) {
        setActionMessageKind("error");
        setActionMessage(await importErrorMessage(response, "Não foi possível desativar o indicador."));
        return;
      }
      setIndicators((currentIndicators) => currentIndicators.filter((currentIndicator) => currentIndicator.id !== indicator.id));
      setActionMessageKind("success");
      setActionMessage(`"${indicator.name}" foi desativado.`);
    } catch {
      setActionMessageKind("error");
      setActionMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setDeactivatingId(null);
    }
  }

  const hasDimensions = indicators.some((indicator) => indicator.dimension);

  return <main className={styles.workspaceShell}>
    <section className={styles.workspaceIntro}>
      <p className={styles.eyebrow}>CATÁLOGO</p>
      <h1>Indicadores</h1>
      <p>Cadastre e mantenha os conceitos usados nas importações. Cada indicador define o que o valor mede, sua unidade e periodicidade.</p>
    </section>
    <section className={styles.tableWorkspace}>
      <div className={styles.tableHeading}><div><p className={styles.eyebrow}>CADASTRADOS</p><h2>Indicadores disponíveis</h2></div><Link className={styles.primaryLink} href="/indicadores/novo"><Plus size={16} />Criar novo indicador</Link></div>
      {actionMessage ? <StatusNotice variant={actionMessageKind}>{actionMessage}</StatusNotice> : null}
      {isLoading ? <StatusNotice variant="loading">Carregando o catálogo de indicadores.</StatusNotice> : null}
      {!isLoading && loadError ? <StatusNotice action={{ label: "Tentar novamente", onClick: () => void loadIndicators() }} variant="error">{loadError}</StatusNotice> : null}
      {!isLoading && !loadError && indicators.length ? <div className={styles.tableWrap}><table><thead><tr><th>Nome</th><th>Código</th>{hasDimensions ? <th>Dimensão</th> : null}<th>Unidade</th><th>Ações</th></tr></thead><tbody>{indicators.map((indicator) => <tr key={indicator.id}>
        <td>{indicator.name}</td>
        <td>{indicator.code}</td>
        {hasDimensions ? <td>{indicator.dimension ?? "-"}</td> : null}
        <td>{indicator.unit}</td>
        <td><div className={styles.rowActions}>
          <Link href={`/indicadores/${indicator.id}`}>Editar</Link>
          <button className={styles.dangerButton} disabled={deactivatingId === indicator.id} onClick={() => void deactivateIndicator(indicator)} type="button">{deactivatingId === indicator.id ? "Desativando..." : "Desativar"}</button>
        </div></td>
      </tr>)}</tbody></table></div> : null}
      {!isLoading && !loadError && !indicators.length ? <p className={styles.profileGuidance}>Ainda não há indicadores cadastrados. Use o botão acima para criar o primeiro.</p> : null}
    </section>
  </main>;
}
