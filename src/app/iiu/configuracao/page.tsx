"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import styles from "../../page.module.css";
import { StatusNotice } from "../../_components/status-notice";
import { importErrorMessage } from "@/lib/import-error-message";

type CityProfile = "pequeno" | "medio" | "grande" | "metropole";
type DimensionConfiguration = { code: string; name: string; color: string; display_order: number; weight: number };
type IndicatorConfiguration = { code: string; name: string; dimension: string; unit: string; display_order: number; minimum_value: number | null; maximum_value: number | null };
type ConfigurationHistoryEntry = { entity_type: string; entity_key: string; old_values: Record<string, unknown> | null; new_values: Record<string, unknown> | null; changed_at: string };
type ConfigurationPayload = { dimensions: DimensionConfiguration[]; indicators: IndicatorConfiguration[]; history: ConfigurationHistoryEntry[] };

const profileOptions: { value: CityProfile; label: string }[] = [
  { value: "pequeno", label: "Pequeno" },
  { value: "medio", label: "Médio" },
  { value: "grande", label: "Grande" },
  { value: "metropole", label: "Metrópole" },
];

function historySummary(entry: ConfigurationHistoryEntry) {
  const newValues = entry.new_values;
  const oldValues = entry.old_values;
  if (!newValues && oldValues) return "Configuração removida";
  if (entry.entity_type === "iiu_dimension_weights") return `Peso: ${newValues?.weight ?? oldValues?.weight ?? "-"}%`;
  if (entry.entity_type === "iiu_indicator_benchmarks") return `Faixa: ${newValues?.minimum_value ?? "-"} a ${newValues?.maximum_value ?? "-"}`;
  const calculationType = newValues?.calculation_type === "ratio" ? "divisão de colunas" : "coluna pronta";
  const scoreDirection = newValues?.score_direction === "inverse" ? "menor valor melhora o score" : newValues?.score_direction === "checklist" ? "checklist" : "maior valor melhora o score";
  return `${calculationType}; ${scoreDirection}`;
}

export default function IiuConfigurationPage() {
  const [cityProfile, setCityProfile] = useState<CityProfile>("medio");
  const [configuration, setConfiguration] = useState<ConfigurationPayload>({ dimensions: [], indicators: [], history: [] });
  const [selectedIndicatorCode, setSelectedIndicatorCode] = useState("");
  const [minimumValue, setMinimumValue] = useState("");
  const [maximumValue, setMaximumValue] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingWeights, setIsSavingWeights] = useState(false);
  const [isSavingBenchmark, setIsSavingBenchmark] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const [notice, setNotice] = useState<{ variant: "success" | "error" | "loading" | "warning"; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    fetch(`/api/iiu-configuration?city_profile=${cityProfile}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível carregar as configurações do IIU."));
        return await response.json() as ConfigurationPayload;
      })
      .then((payload) => {
        if (cancelled) return;
        setConfiguration(payload);
        const firstIndicator = payload.indicators[0];
        setSelectedIndicatorCode((currentCode) => payload.indicators.some((indicator) => indicator.code === currentCode) ? currentCode : firstIndicator?.code ?? "");
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setNotice({ variant: "error", message: loadError instanceof Error ? loadError.message : "Não foi possível carregar as configurações do IIU." });
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [cityProfile, refreshAttempt]);

  const selectedIndicator = configuration.indicators.find((indicator) => indicator.code === selectedIndicatorCode);
  const weightTotal = useMemo(() => configuration.dimensions.reduce((total, dimension) => total + dimension.weight, 0), [configuration.dimensions]);

  useEffect(() => {
    if (!selectedIndicator) return;
    setMinimumValue(selectedIndicator.minimum_value === null ? "" : String(selectedIndicator.minimum_value));
    setMaximumValue(selectedIndicator.maximum_value === null ? "" : String(selectedIndicator.maximum_value));
  }, [selectedIndicator]);

  function updateWeight(dimensionCode: string, weight: number) {
    setConfiguration((currentConfiguration) => ({ ...currentConfiguration, dimensions: currentConfiguration.dimensions.map((dimension) => dimension.code === dimensionCode ? { ...dimension, weight } : dimension) }));
  }

  async function saveWeights(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSavingWeights(true);
    setNotice(null);
    try {
      const weights = Object.fromEntries(configuration.dimensions.map((dimension) => [dimension.code, dimension.weight]));
      const response = await fetch("/api/iiu-configuration/weights", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ city_profile: cityProfile, weights }) });
      if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível salvar os pesos."));
      setNotice({ variant: "success", message: "Pesos atualizados. Os próximos diagnósticos usarão essa distribuição." });
      setRefreshAttempt((attempt) => attempt + 1);
    } catch (saveError: unknown) {
      setNotice({ variant: "error", message: saveError instanceof Error ? saveError.message : "Não foi possível salvar os pesos." });
    } finally {
      setIsSavingWeights(false);
    }
  }

  async function suggestBenchmark() {
    if (!selectedIndicator) return;
    setIsSuggesting(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/iiu-configuration/benchmark-suggestion?indicator_code=${encodeURIComponent(selectedIndicator.code)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível sugerir uma faixa para este indicador."));
      const suggestion = await response.json() as { minimum_value: number; maximum_value: number; sample_size: number; reference_period_from: string; reference_period_to: string };
      setMinimumValue(String(suggestion.minimum_value));
      setMaximumValue(String(suggestion.maximum_value));
      setNotice({ variant: "success", message: `Faixa sugerida com base em ${new Intl.NumberFormat("pt-BR").format(suggestion.sample_size)} municípios (percentis 10 e 90). Confira os valores e clique em salvar para aplicar neste porte.` });
    } catch (suggestError: unknown) {
      setNotice({ variant: "error", message: suggestError instanceof Error ? suggestError.message : "Não foi possível sugerir uma faixa para este indicador." });
    } finally {
      setIsSuggesting(false);
    }
  }

  async function saveBenchmark(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedIndicator) return;
    setIsSavingBenchmark(true);
    setNotice(null);
    try {
      const response = await fetch("/api/iiu-configuration/benchmark", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ indicator_code: selectedIndicator.code, city_profile: cityProfile, minimum_value: Number(minimumValue), maximum_value: Number(maximumValue) }) });
      if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível salvar a referência do indicador."));
      setConfiguration((currentConfiguration) => ({ ...currentConfiguration, indicators: currentConfiguration.indicators.map((indicator) => indicator.code === selectedIndicator.code ? { ...indicator, minimum_value: Number(minimumValue), maximum_value: Number(maximumValue) } : indicator) }));
      setNotice({ variant: "success", message: `Referência de ${selectedIndicator.name} atualizada para o porte ${profileOptions.find((profile) => profile.value === cityProfile)?.label}.` });
      setRefreshAttempt((attempt) => attempt + 1);
    } catch (saveError: unknown) {
      setNotice({ variant: "error", message: saveError instanceof Error ? saveError.message : "Não foi possível salvar a referência do indicador." });
    } finally {
      setIsSavingBenchmark(false);
    }
  }

  return <main className={styles.workspaceShell}>
    <Link className={styles.backLink} href="/iiu"><ArrowLeft size={16} />Voltar ao diagnóstico IIU</Link>
    <section className={styles.workspaceIntro}><p className={styles.eyebrow}>CONFIGURAÇÃO DO ÍNDICE</p><h1>Pesos e referências</h1><p>Defina a importância das dimensões e a faixa de referência dos indicadores por porte municipal.</p></section>
    <div className={styles.sourceForm}>
      <label>Porte municipal<select onChange={(event) => setCityProfile(event.target.value as CityProfile)} value={cityProfile}>{profileOptions.map((profile) => <option key={profile.value} value={profile.value}>{profile.label}</option>)}</select><span className={styles.fieldNote}>Cada porte guarda seus próprios pesos e referências.</span></label>
    </div>
    {notice ? <StatusNotice variant={notice.variant}>{notice.message}</StatusNotice> : null}
    {isLoading ? <StatusNotice variant="loading">Carregando pesos, indicadores e referências.</StatusNotice> : null}
    {!isLoading ? <div className={styles.iiuConfigurationSections}>
      <section className={styles.analysisPanel}>
        <div className={styles.sectionHeading}><div><h2>Peso de cada dimensão</h2><span>A soma precisa fechar em 100%. O cálculo do IIU redistribui os pesos quando alguma dimensão não tem dados.</span></div></div>
        <form className={styles.sourceForm} onSubmit={(event) => void saveWeights(event)}>
          {configuration.dimensions.map((dimension) => <label key={dimension.code}>{dimension.name} (%)<input max="100" min="0.01" onChange={(event) => updateWeight(dimension.code, Number(event.target.value))} required step="0.01" type="number" value={dimension.weight} /></label>)}
          <StatusNotice variant={Math.abs(weightTotal - 100) < 0.01 ? "success" : "warning"}>Soma atual: {new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(weightTotal)}%. {Math.abs(weightTotal - 100) < 0.01 ? "Pronta para salvar." : "Ajuste os valores até chegar a 100%."}</StatusNotice>
          <button className={styles.primaryButton} disabled={isSavingWeights || isLoading || Math.abs(weightTotal - 100) > 0.01} type="submit">{isSavingWeights ? "Salvando pesos..." : "Salvar pesos deste porte"}</button>
        </form>
      </section>
      <section className={styles.analysisPanel}>
        <div className={styles.sectionHeading}><div><h2>Referência dos indicadores</h2><span>O valor mínimo equivale ao score 0 e o máximo ao score 100. Indicadores inversos aplicam essa faixa na direção contrária.</span></div></div>
        {configuration.indicators.length ? <form className={styles.sourceForm} onSubmit={(event) => void saveBenchmark(event)}>
          <label>Indicador<select onChange={(event) => setSelectedIndicatorCode(event.target.value)} value={selectedIndicatorCode}>{configuration.indicators.map((indicator) => <option key={indicator.code} value={indicator.code}>{indicator.name} · {indicator.dimension}</option>)}</select></label>
          {selectedIndicator ? <>
            <p className={styles.fieldNote}>Unidade cadastrada: {selectedIndicator.unit}. Defina os limites que serão usados para normalizar os dados deste porte.</p>
            <label>Valor mínimo<input onChange={(event) => setMinimumValue(event.target.value)} required step="any" type="number" value={minimumValue} /></label>
            <label>Valor máximo<input onChange={(event) => setMaximumValue(event.target.value)} required step="any" type="number" value={maximumValue} /></label>
            <button className={styles.secondaryLink} disabled={isSuggesting || isSavingBenchmark} onClick={() => void suggestBenchmark()} type="button">{isSuggesting ? "Calculando..." : "Sugerir pela base importada"}</button>
            <p className={styles.fieldNote}>A sugestão usa os percentis 10 e 90 do valor mais recente de cada município já aprovado. Precisa de pelo menos 30 municípios.</p>
            <button className={styles.primaryButton} disabled={isSavingBenchmark || !minimumValue || !maximumValue || Number(minimumValue) >= Number(maximumValue)} type="submit">{isSavingBenchmark ? "Salvando referência..." : "Salvar referência"}</button>
          </> : null}
        </form> : <StatusNotice variant="info">Não há indicadores habilitados para o IIU no catálogo.</StatusNotice>}
      </section>
      <section className={styles.analysisPanel}>
        <div className={styles.sectionHeading}><div><h2>Alterações recentes</h2><span>Registro das mudanças em fórmulas, pesos e referências.</span></div></div>
        {configuration.history.length ? <div className={styles.tableWrap}><table><thead><tr><th>Quando</th><th>Tipo</th><th>Item</th><th>Alteração</th></tr></thead><tbody>{configuration.history.map((entry, index) => <tr key={`${entry.entity_type}-${entry.entity_key}-${entry.changed_at}-${index}`}><td>{new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(entry.changed_at))}</td><td>{entry.entity_type === "iiu_dimension_weights" ? "Peso de dimensão" : entry.entity_type === "iiu_indicator_benchmarks" ? "Referência" : "Indicador"}</td><td>{entry.entity_key}</td><td>{historySummary(entry)}</td></tr>)}</tbody></table></div> : <StatusNotice variant="info">As alterações feitas a partir de agora aparecerão aqui.</StatusNotice>}
      </section>
    </div> : null}
  </main>;
}
