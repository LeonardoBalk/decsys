"use client";

import { useEffect, useState } from "react";
import styles from "./paineis.module.css";
import type { IiuMunicipality } from "@/lib/types/iiu-paineis";

type MunicipalitySearchProps = {
  label: string;
  onSelect: (municipality: IiuMunicipality) => void;
  excludeCodes?: string[];
  disabled?: boolean;
  placeholder?: string;
};

export function MunicipalitySearch({ label, onSelect, excludeCodes = [], disabled = false, placeholder = "Nome ou código IBGE" }: MunicipalitySearchProps) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<IiuMunicipality[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState("");
  const trimmed = text.trim();
  const canSearch = trimmed.length >= 2;

  useEffect(() => {
    if (!canSearch) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setIsSearching(true);
      fetch(`/api/iiu-municipalities?search=${encodeURIComponent(trimmed)}`, { cache: "no-store" })
        .then(async (response) => {
          const payload: unknown = await response.json().catch(() => null);
          if (!response.ok || !Array.isArray(payload)) throw new Error("Não foi possível pesquisar municípios agora.");
          return payload as IiuMunicipality[];
        })
        .then((found) => { if (!cancelled) { setResults(found); setError(""); } })
        .catch((searchError: unknown) => { if (!cancelled) { setResults([]); setError(searchError instanceof Error ? searchError.message : "Não foi possível pesquisar municípios agora."); } })
        .finally(() => { if (!cancelled) setIsSearching(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [trimmed, canSearch]);

  function choose(municipality: IiuMunicipality) {
    onSelect(municipality);
    setText("");
    setResults([]);
  }

  const visibleResults = canSearch ? results.filter((municipality) => !excludeCodes.includes(municipality.ibge_code)) : [];

  return <div className={styles.search}>
    <label>{label}<input autoComplete="off" disabled={disabled} onChange={(event) => setText(event.target.value)} placeholder={placeholder} value={text} /></label>
    {canSearch && isSearching ? <span className={styles.searchNote}>Pesquisando...</span> : null}
    {canSearch && error ? <span className={styles.searchNote}>{error}</span> : null}
    {canSearch && !isSearching && !error && !visibleResults.length ? <span className={styles.searchNote}>Nenhum município encontrado. Só aparecem municípios que já têm dados importados.</span> : null}
    {visibleResults.length ? <ul className={styles.searchResults}>{visibleResults.map((municipality) => <li key={municipality.ibge_code}><button onClick={() => choose(municipality)} type="button">{municipality.name} - {municipality.state}<span>{municipality.ibge_code}</span></button></li>)}</ul> : null}
  </div>;
}
