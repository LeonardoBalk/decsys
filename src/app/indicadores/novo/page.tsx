"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import styles from "../../page.module.css";
import { emptyRegistration, IndicatorForm, IndicatorRegistration } from "../../_components/indicator-form";
import { importErrorMessage } from "@/lib/import-error-message";

export default function NewIndicatorPage() {
  const [formRegistration, setFormRegistration] = useState<IndicatorRegistration>(emptyRegistration);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"error" | "success">("error");

  async function createIndicator(registration: IndicatorRegistration) {
    setIsSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/indicators", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(registration) });
      if (!response.ok) {
        setMessageKind("error");
        setMessage(await importErrorMessage(response, "Não foi possível cadastrar o indicador."));
        setFormRegistration(registration);
        return;
      }
      const createdIndicator = await response.json();
      setFormRegistration({ ...emptyRegistration });
      setMessageKind("success");
      setMessage(`Indicador "${createdIndicator.name}" cadastrado com o código ${createdIndicator.code}. Ele já está disponível nas próximas importações.`);
    } catch {
      setMessageKind("error");
      setMessage("Não foi possível acessar o serviço de tratamento.");
      setFormRegistration(registration);
    } finally {
      setIsSaving(false);
    }
  }

  return <main className={styles.workspaceShell}>
    <Link className={styles.backLink} href="/indicadores"><ArrowLeft size={16} />Voltar aos indicadores</Link>
    <section className={styles.workspaceIntro}><p className={styles.eyebrow}>CATÁLOGO</p><h1>Novo indicador</h1><p>Defina o conceito que será associado aos dados importados e usado depois nos painéis.</p></section>
    <section className={styles.analysisPanel}>
      <div className={styles.sectionHeading}><div><h2>Informações do indicador</h2><span>Use códigos curtos e estáveis. Eles identificam o indicador nas consultas e dashboards.</span></div></div>
      <IndicatorForm initialRegistration={formRegistration} isEditing={false} isSaving={isSaving} message={message} messageKind={messageKind} onSubmit={(registration) => void createIndicator(registration)} />
    </section>
  </main>;
}
