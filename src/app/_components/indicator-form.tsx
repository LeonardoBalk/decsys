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
  calculation_type: "direct" | "ratio";
  calculation_multiplier: string;
  iiu_enabled: boolean;
  iiu_dimension_code: string;
  score_direction: "direct" | "inverse" | "checklist";
  checklist_max: string;
};

type IndicatorRegistrationTextField = Exclude<keyof IndicatorRegistration, "iiu_enabled">;

export const emptyRegistration: IndicatorRegistration = { code: "", name: "", dimension: "", definition: "", unit: "", expected_frequency: "", calculation_type: "direct", calculation_multiplier: "1", iiu_enabled: false, iiu_dimension_code: "", score_direction: "direct", checklist_max: "" };

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

function useIiuDimensions() {
  const [dimensions, setDimensions] = useState<{ code: string; name: string }[]>([]);
  useEffect(() => {
    fetch("/api/iiu-configuration?city_profile=medio", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { dimensions?: { code: string; name: string }[] } | null) => { if (payload && Array.isArray(payload.dimensions)) setDimensions(payload.dimensions); })
      .catch(() => undefined);
  }, []);
  return dimensions;
}

export function IndicatorForm({ initialRegistration, isEditing, isSaving, message, messageKind, onSubmit }: IndicatorFormProps) {
  const [registration, setRegistration] = useState(initialRegistration);
  const dimensionSuggestions = useDimensionSuggestions();
  const iiuDimensions = useIiuDimensions();

  useEffect(() => { setRegistration(initialRegistration); }, [initialRegistration]);

  function updateRegistration<FieldName extends IndicatorRegistrationTextField>(fieldName: FieldName, fieldValue: IndicatorRegistration[FieldName]) {
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
    <label>Como calcular o valor?<select onChange={(event) => updateRegistration("calculation_type", event.target.value as "direct" | "ratio")} value={registration.calculation_type}><option value="direct">Usar uma coluna pronta</option><option value="ratio">Dividir uma coluna por outra</option></select><span className={styles.fieldNote}>Use uma coluna pronta quando a fonte já traz o indicador calculado. Escolha divisão para taxas e proporções calculadas durante a importação.</span></label>
    {registration.calculation_type === "ratio" ? <label>Multiplicador da divisão<input min="0.000001" onChange={(event) => updateRegistration("calculation_multiplier", event.target.value)} required step="any" type="number" value={registration.calculation_multiplier} /><span className={styles.fieldNote}>Exemplo: para calcular percentual, use 100. A fórmula será numerador ÷ denominador × multiplicador.</span></label> : null}
    <label className={styles.checkboxLabel}><input checked={registration.iiu_enabled} onChange={(event) => setRegistration((currentRegistration) => ({ ...currentRegistration, iiu_enabled: event.target.checked }))} type="checkbox" />Incluir este indicador no cálculo do IIU</label>
    {registration.iiu_enabled ? <>
      <label>Dimensão do IIU<select onChange={(event) => updateRegistration("iiu_dimension_code", event.target.value)} required value={registration.iiu_dimension_code}><option disabled value="">Selecione uma dimensão</option>{iiuDimensions.map((dimension) => <option key={dimension.code} value={dimension.code}>{dimension.name}</option>)}</select></label>
      <label>Como o valor vira score?<select onChange={(event) => updateRegistration("score_direction", event.target.value as IndicatorRegistration["score_direction"])} value={registration.score_direction}><option value="direct">Maior valor significa melhor resultado</option><option value="inverse">Menor valor significa melhor resultado</option><option value="checklist">Pontuação de checklist</option></select><span className={styles.fieldNote}>As faixas de score são configuradas depois na página Pesos e referências do IIU.</span></label>
      {registration.score_direction === "checklist" ? <label>Pontuação máxima do checklist<input min="0.000001" onChange={(event) => updateRegistration("checklist_max", event.target.value)} required step="any" type="number" value={registration.checklist_max} /></label> : null}
    </> : null}
    {message ? <StatusNotice variant={messageKind}>{message}</StatusNotice> : null}
    <div className={styles.formActions}><Link href="/indicadores">{messageKind === "success" && message ? "Voltar aos indicadores" : "Cancelar"}</Link><button className={styles.primaryButton} disabled={isSaving} type="submit">{isSaving ? "Salvando..." : isEditing ? "Salvar alterações" : "Cadastrar indicador"}</button></div>
  </form>;
}
