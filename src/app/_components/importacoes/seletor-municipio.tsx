import { useEffect, useState } from "react";
import styles from "../../page.module.css";
import { MunicipalityDecision, MunicipalitySuggestion, municipalityLabel } from "@/lib/municipality-decisions";

type MunicipalityPickerProps = {
  originalName: string;
  current: { ibge_code: string; label: string } | null;
  candidates: MunicipalitySuggestion[];
  canRestore: boolean;
  onChoose: (decision: MunicipalityDecision) => void;
  onRestore: () => void;
};

export function MunicipalityPicker({ originalName, current, candidates, canRestore, onChoose, onRestore }: MunicipalityPickerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [results, setResults] = useState<MunicipalitySuggestion[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  useEffect(() => {
    if (!isEditing) return;
    const trimmedSearch = searchText.trim();
    if (trimmedSearch.length < 2) {
      setResults([]);
      setSearchError("");
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setIsSearching(true);
      fetch(`/api/ibge-municipalities?search=${encodeURIComponent(trimmedSearch)}`, { cache: "no-store" })
        .then(async (response) => {
          const payload: unknown = await response.json();
          if (!response.ok || !Array.isArray(payload)) throw new Error("Não foi possível consultar o catálogo do IBGE agora.");
          return payload as MunicipalitySuggestion[];
        })
        .then((municipalities) => { if (!cancelled) { setResults(municipalities); setSearchError(""); } })
        .catch((error: unknown) => { if (!cancelled) setSearchError(error instanceof Error ? error.message : "Não foi possível consultar o catálogo do IBGE agora."); })
        .finally(() => { if (!cancelled) setIsSearching(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [isEditing, searchText]);

  function startEditing() {
    setSearchText("");
    setResults([]);
    setIsEditing(true);
  }

  function choose(municipality: MunicipalitySuggestion) {
    onChoose({ ibge_code: municipality.ibge_code, label: municipalityLabel(municipality), origin: candidates.some((candidate) => candidate.ibge_code === municipality.ibge_code) ? "candidate" : "manual" });
    setIsEditing(false);
  }

  if (!isEditing) return <div className={styles.pickerSummary}>
    <span>{current ? <><strong>{current.label}</strong> · {current.ibge_code}</> : <em>Sem código</em>}</span>
    <div className={styles.rowActions}>
      <button onClick={startEditing} type="button">{current ? "Alterar" : "Escolher"}</button>
      {canRestore ? <button onClick={onRestore} type="button">Desfazer</button> : null}
    </div>
  </div>;

  const optionList = searchText.trim().length >= 2 ? results : candidates;

  return <div className={styles.pickerEditor}>
    <input aria-label={`Pesquisar município para ${originalName}`} autoFocus className={styles.tableControl} onChange={(event) => setSearchText(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setIsEditing(false); }} placeholder="Nome, nome (UF) ou código IBGE" value={searchText} />
    {searchText.trim().length < 2 && candidates.length ? <span className={styles.fieldNote}>Opções encontradas para este nome:</span> : null}
    {isSearching ? <span className={styles.fieldNote}>Pesquisando no catálogo do IBGE...</span> : null}
    {searchError ? <span className={styles.fieldNote}>{searchError}</span> : null}
    {!isSearching && searchText.trim().length >= 2 && !results.length && !searchError ? <span className={styles.fieldNote}>Nenhum município encontrado.</span> : null}
    {optionList.length ? <div className={styles.pickerOptions}>{optionList.map((municipality) => <button key={municipality.ibge_code} onClick={() => choose(municipality)} type="button">{municipalityLabel(municipality)}<span>{municipality.ibge_code}</span></button>)}</div> : null}
    <div className={styles.rowActions}>
      <button onClick={() => { onChoose({ ibge_code: null, label: "", origin: "manual" }); setIsEditing(false); }} type="button">Deixar sem código</button>
      <button onClick={() => setIsEditing(false)} type="button">Cancelar</button>
    </div>
  </div>;
}
