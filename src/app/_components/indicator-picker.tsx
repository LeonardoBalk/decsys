"use client";

import { KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import styles from "./indicator-picker.module.css";
import type { Indicator } from "@/lib/types/importacao";
import { groupByDimension, searchIndicators, shortIndicatorCode } from "@/lib/indicator-search";

type IndicatorPickerProps = {
  indicators: Indicator[];
  value: string;
  onChange: (indicatorId: string) => void;
  /** Indicadores que não podem ser escolhidos (ex.: já usados em outra medida). */
  isDisabled?: (indicator: Indicator) => boolean;
  onCreateNew?: () => void;
  placeholder?: string;
  label?: string;
};

export function IndicatorPicker({ indicators, value, onChange, isDisabled, onCreateNew, placeholder = "Buscar por sigla, nome ou dimensão", label = "Indicador" }: IndicatorPickerProps) {
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const selected = indicators.find((indicator) => indicator.id === value);

  const results = useMemo(() => searchIndicators(indicators, query), [indicators, query]);
  const groups = useMemo(() => groupByDimension(results), [results]);
  const flat = useMemo(() => groups.flatMap((group) => group.indicators), [groups]);

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  function choose(indicator: Indicator) {
    if (isDisabled?.(indicator)) return;
    onChange(indicator.id);
    setQuery("");
    setIsOpen(false);
  }

  function moveHighlight(step: 1 | -1) {
    if (!flat.length) return;
    let next = highlighted;
    for (let attempt = 0; attempt < flat.length; attempt += 1) {
      next = (next + step + flat.length) % flat.length;
      if (!isDisabled?.(flat[next])) break;
    }
    setHighlighted(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); if (!isOpen) setIsOpen(true); else moveHighlight(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); moveHighlight(-1); }
    else if (event.key === "Enter" && isOpen) { event.preventDefault(); if (flat[highlighted]) choose(flat[highlighted]); }
    else if (event.key === "Escape") { setIsOpen(false); setQuery(""); }
  }

  const optionId = (indicator: Indicator) => `${listId}-${indicator.id}`;
  const displayValue = isOpen ? query : selected ? `${shortIndicatorCode(selected.code)} — ${selected.name.replace(/^[A-Z]{3}\d{2} — /, "")}` : "";

  return <div className={styles.group}>
    <span className={styles.label} id={`${listId}-label`}>{label}</span>
    <div className={styles.picker} ref={containerRef}>
    <div className={styles.field}>
      <Search aria-hidden size={15} />
      <input
        aria-activedescendant={isOpen && flat[highlighted] ? optionId(flat[highlighted]) : undefined}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={isOpen}
        aria-labelledby={`${listId}-label`}
        autoComplete="off"
        onChange={(event) => { setQuery(event.target.value); setHighlighted(0); setIsOpen(true); }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={selected ? "Trocar indicador…" : placeholder}
        role="combobox"
        value={displayValue}
      />
    </div>
    {isOpen ? <div className={styles.popover}>
      <ul className={styles.list} id={listId} role="listbox">
        {groups.map((group) => <li key={group.dimension} role="presentation">
          <p className={styles.groupLabel}>{group.dimension}</p>
          <ul role="group" aria-label={group.dimension}>
            {group.indicators.map((indicator) => {
              const index = flat.indexOf(indicator);
              const disabled = Boolean(isDisabled?.(indicator));
              return <li
                aria-disabled={disabled}
                aria-selected={indicator.id === value}
                className={`${styles.option} ${index === highlighted ? styles.highlighted : ""} ${disabled ? styles.disabled : ""}`}
                id={optionId(indicator)}
                key={indicator.id}
                onClick={() => choose(indicator)}
                onMouseEnter={() => setHighlighted(index)}
                role="option"
              >
                <span className={styles.code}>{shortIndicatorCode(indicator.code)}</span>
                <span className={styles.name}>{indicator.name.replace(/^[A-Z]{3}\d{2} — /, "")}</span>
                <span className={styles.unit}>{disabled ? "já usado" : indicator.unit}</span>
              </li>;
            })}
          </ul>
        </li>)}
      </ul>
      {!flat.length ? <p className={styles.empty}>Nenhum indicador encontrado para “{query}”.</p> : null}
      {onCreateNew ? <button className={styles.create} onClick={() => { setIsOpen(false); onCreateNew(); }} type="button"><Plus size={14} />Cadastrar um novo indicador</button> : null}
    </div> : null}
    </div>
  </div>;
}
