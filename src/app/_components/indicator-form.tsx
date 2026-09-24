"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import styles from "../page.module.css";
import { StatusNotice } from "./status-notice";

export type IndicatorRegistration = {
  code: string;
  name: string;
  dimension: string;
  definition: string;
  unit: string;
  expected_frequency: string;
};

export const emptyRegistration: IndicatorRegistration = { code: "", name: "", dimension: "", definition: "", unit: "", expected_frequency: "" };

const frequencyOptions = ["mensal", "trimestral", "semestral", "anual", "bienal", "decenal"];

type IndicatorFormProps = {
  initialRegistration: IndicatorRegistration;
  isEditing: boolean;
  isSaving: boolean;
  message: string;
  messageKind: "error" | "success";
  onSubmit: (registration: IndicatorRegistration) => void;
};

function useDimensionSuggestions() {
  const [dimensions, setDimensions] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/indicator-dimensions", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : [])
      .then((payload: unknown) => { if (Array.isArray(payload)) setDimensions(payload.filter((dimension): dimension is string => typeof dimension === "string")); })
      .catch(() => undefined);
  }, []);
  return dimensions;
}

export function IndicatorForm({ initialRegistration, isEditing, isSaving, message, messageKind, onSubmit }: IndicatorFormProps) {
  const [registration, setRegistration] = useState(initialRegistration);
  const dimensionSuggestions = useDimensionSuggestions();

  useEffect(() => { setRegistration(initialRegistration); }, [initialRegistration]);

  function updateRegistration(fieldName: keyof IndicatorRegistration, fieldValue: string) {
    setRegistration((currentRegistration) => ({ ...currentRegistration, [fieldName]: fieldValue }));
  }

  function submitRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(registration);
  }

  return <form className={styles.sourceForm} onSubmit={submitRegistration}>
    <label>Nome<input onChange={(event) => updateRegistration("name", event.target.value)} required value={registration.name} /></label>
    <label>Código interno<input disabled={isEditing} onChange={(event) => updateRegistration("code", event.target.value)} placeholder="Ex.: caged_saldo_empregos" required value={registration.code} /><span className={styles.fieldNote}>{isEditing ? "O código não pode ser alterado porque identifica os valores já publicados." : "Letras minúsculas, números e sublinhados, começando por letra. Acentos e espaços são convertidos automaticamente."}</span></label>
    <label>Dimensão<input list="indicator-dimensions" onChange={(event) => updateRegistration("dimension", event.target.value)} placeholder="Ex.: Mobilidade, Saúde, Economia" required value={registration.dimension} /><datalist id="indicator-dimensions">{dimensionSuggestions.map((dimension) => <option key={dimension} value={dimension} />)}</datalist><span className={styles.fieldNote}>Escolha uma dimensão existente para manter o catálogo organizado, ou digite uma nova.</span></label>
    <label>Definição<textarea onChange={(event) => updateRegistration("definition", event.target.value)} placeholder="Explique com clareza o que o valor representa, como é calculado e qual a fonte usual." required rows={4} value={registration.definition} /></label>
    <label>Unidade<input onChange={(event) => updateRegistration("unit", event.target.value)} placeholder="Ex.: pessoas, %, kW" required value={registration.unit} /></label>
    <label>Periodicidade<input list="indicator-frequencies" onChange={(event) => updateRegistration("expected_frequency", event.target.value)} placeholder="Ex.: mensal ou anual" value={registration.expected_frequency} /><datalist id="indicator-frequencies">{frequencyOptions.map((frequency) => <option key={frequency} value={frequency} />)}</datalist></label>
    {message ? <StatusNotice variant={messageKind}>{message}</StatusNotice> : null}
    <div className={styles.formActions}><Link href="/indicadores">{messageKind === "success" && message ? "Voltar aos indicadores" : "Cancelar"}</Link><button className={styles.primaryButton} disabled={isSaving} type="submit">{isSaving ? "Salvando..." : isEditing ? "Salvar alterações" : "Cadastrar indicador"}</button></div>
  </form>;
}
