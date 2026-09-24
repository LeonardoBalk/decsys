import styles from "../../page.module.css";
import { SourceProfile } from "@/lib/types/importacao";
import { monthNames, PeriodGranularity, PeriodMode, periodModeLabels, PeriodSelection } from "@/lib/period-selection";

type PeriodFieldsProps = {
  columns: SourceProfile["columns"];
  selection: PeriodSelection;
  hasPreparedPeriod: boolean;
  preparedGranularity: PeriodGranularity | null;
  onChange: (selection: PeriodSelection) => void;
};

function ColumnSelect({ label, value, columns, onChange }: { label: string; value: string; columns: SourceProfile["columns"]; onChange: (value: string) => void }) {
  return <label>{label}<select onChange={(event) => onChange(event.target.value)} required value={value}><option disabled value="">Selecione uma coluna</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label>;
}

function GranularitySelect({ value, onChange }: { value: PeriodGranularity; onChange: (value: PeriodGranularity) => void }) {
  return <label>Os valores se referem a<select onChange={(event) => onChange(event.target.value as PeriodGranularity)} value={value}><option value="year">Um ano inteiro</option><option value="month">Um mês</option></select></label>;
}

export function PeriodFields({ columns, selection, hasPreparedPeriod, preparedGranularity, onChange }: PeriodFieldsProps) {
  const availableModes = (Object.keys(periodModeLabels) as PeriodMode[]).filter((mode) => mode !== "prepared" || hasPreparedPeriod);

  function update(changes: Partial<PeriodSelection>) {
    onChange({ ...selection, ...changes });
  }

  return <fieldset className={styles.periodFieldset}>
    <legend>Qual é o período dos valores?</legend>
    <label>Como o período aparece na planilha?<select onChange={(event) => update({ mode: event.target.value as PeriodMode })} value={selection.mode}>{availableModes.map((mode) => <option key={mode} value={mode}>{periodModeLabels[mode]}</option>)}</select></label>
    {selection.mode === "year_column" ? <ColumnSelect columns={columns} label="Coluna com o ano" onChange={(yearField) => update({ yearField })} value={selection.yearField} /> : null}
    {selection.mode === "date_column" ? <>
      <ColumnSelect columns={columns} label="Coluna com a data ou o mês/ano" onChange={(dateField) => update({ dateField })} value={selection.dateField} />
      <GranularitySelect onChange={(granularity) => update({ granularity })} value={selection.granularity} />
    </> : null}
    {selection.mode === "month_year_columns" ? <>
      <ColumnSelect columns={columns} label="Coluna com o mês (número ou nome)" onChange={(monthField) => update({ monthField })} value={selection.monthField} />
      <ColumnSelect columns={columns} label="Coluna com o ano" onChange={(yearField) => update({ yearField })} value={selection.yearField} />
    </> : null}
    {selection.mode === "fixed" ? <>
      <label>Ano<input inputMode="numeric" max={2200} min={1900} onChange={(event) => update({ fixedYear: event.target.value.replace(/\D/g, "").slice(0, 4) })} placeholder="Ex.: 2024" required value={selection.fixedYear} /></label>
      <GranularitySelect onChange={(granularity) => update({ granularity })} value={selection.granularity} />
      {selection.granularity === "month" ? <label>Mês<select onChange={(event) => update({ fixedMonth: event.target.value })} required value={selection.fixedMonth}><option disabled value="">Selecione o mês</option>{monthNames.map((monthName, index) => <option key={monthName} value={String(index + 1)}>{monthName}</option>)}</select></label> : null}
      <span className={styles.fieldNote}>Use quando a planilha inteira se refere ao mesmo período, por exemplo quando o ano está só no título ou no nome do arquivo.</span>
    </> : null}
    {selection.mode === "prepared" ? <span className={styles.fieldNote}>O período vem da coluna transformada no quadro acima ({preparedGranularity === "month" ? "valores mensais" : "valores anuais"}).</span> : null}
  </fieldset>;
}
