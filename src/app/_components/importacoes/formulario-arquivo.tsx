import { ChangeEvent, FormEvent } from "react";
import styles from "../../page.module.css";

type FileImportFormProps = {
  isAnalyzing: boolean;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function FileImportForm({ isAnalyzing, onFileChange, onSubmit }: FileImportFormProps) {
  return <form className={styles.sourceForm} onSubmit={onSubmit}>
    <div className={styles.sectionHeading}><div><h3>Enviar arquivo</h3><span>CSV, XLSX, XLS ou JSON.</span></div></div>
    <label>Arquivo<input accept=".csv,.xlsx,.xls,.json" onChange={onFileChange} type="file" /></label>
    <p className={styles.fieldNote}>Use este caminho quando você já baixou a base ou recebeu uma planilha.</p>
    <button className={styles.primaryButton} disabled={isAnalyzing} type="submit">Analisar arquivo</button>
  </form>;
}
