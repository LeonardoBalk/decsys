"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import styles from "../../page.module.css";
import { IndicatorForm, IndicatorRegistration } from "../../_components/indicator-form";
import { StatusNotice } from "../../_components/status-notice";
import { Indicator } from "@/lib/types/importacao";
import { importErrorMessage } from "@/lib/import-error-message";

function registrationFromIndicator(indicator: Indicator): IndicatorRegistration {
  return { code: indicator.code, name: indicator.name, dimension: indicator.dimension ?? "", definition: indicator.definition ?? "", unit: indicator.unit, expected_frequency: indicator.expected_frequency ?? "" };
}

export default function EditIndicatorPage() {
  const { indicatorId } = useParams<{ indicatorId: string }>();
  const [registration, setRegistration] = useState<IndicatorRegistration | null>(null);
  const [loadError, setLoadError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"error" | "success">("error");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/indicators/${encodeURIComponent(indicatorId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível carregar o indicador."));
        return response.json() as Promise<Indicator>;
      })
      .then((indicator) => { if (!cancelled) setRegistration(registrationFromIndicator(indicator)); })
      .catch((error: unknown) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : "Não foi possível carregar o indicador."); });
    return () => { cancelled = true; };
  }, [indicatorId]);

  async function updateIndicator(updatedRegistration: IndicatorRegistration) {
    setIsSaving(true);
    setMessage("");
    try {
      const { code: _code, ...editableFields } = updatedRegistration;
      const response = await fetch(`/api/indicators/${encodeURIComponent(indicatorId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editableFields) });
      if (!response.ok) {
        setMessageKind("error");
        setMessage(await importErrorMessage(response, "Não foi possível salvar as alterações."));
        setRegistration(updatedRegistration);
        return;
      }
      setRegistration(registrationFromIndicator(await response.json()));
      setMessageKind("success");
      setMessage("Alterações salvas. As próximas importações e os painéis já usam a nova descrição.");
    } catch {
      setMessageKind("error");
      setMessage("Não foi possível acessar o serviço de tratamento.");
    } finally {
      setIsSaving(false);
    }
  }

  return <main className={styles.workspaceShell}>
    <Link className={styles.backLink} href="/indicadores"><ArrowLeft size={16} />Voltar aos indicadores</Link>
    <section className={styles.workspaceIntro}><p className={styles.eyebrow}>CATÁLOGO</p><h1>Editar indicador</h1><p>Ajuste nome, definição, unidade e periodicidade. O código fica fixo para não desconectar os valores já publicados.</p></section>
    <section className={styles.analysisPanel}>
      {!registration && !loadError ? <StatusNotice variant="loading">Carregando o indicador.</StatusNotice> : null}
      {loadError ? <StatusNotice variant="error">{loadError}</StatusNotice> : null}
      {registration ? <IndicatorForm initialRegistration={registration} isEditing isSaving={isSaving} message={message} messageKind={messageKind} onSubmit={(nextRegistration) => void updateIndicator(nextRegistration)} /> : null}
    </section>
  </main>;
}
