import { ChangeEvent, FormEvent } from "react";
import styles from "../../page.module.css";

type FileImportFormProps = {
  isAnalyzing: boolean;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function FileImportForm({ isAnalyzing, onFileChange, onSubmit }: FileImportFormProps) {
  return <form className={styles.sourceForm} onSubmit={onSubmit}>
    <div className={styles.sectionHeading}><div><h3>Enviar arquivo</h3><span>Escolha uma planilha ou arquivo de dados que você já tenha em mãos.</span></div></div>
    <label>Arquivo<input accept=".csv,.xlsx,.xls,.json,.zip,.gz" disabled={isAnalyzing} onChange={onFileChange} type="file" /></label>
    <p className={styles.fieldNote}>Formatos aceitos: CSV, Excel (XLS ou XLSX), JSON e arquivos compactados ZIP ou GZ com esses dados. O arquivo original não é alterado.</p>
    <button className={styles.primaryButton} disabled={isAnalyzing} type="submit">{isAnalyzing ? "Lendo arquivo..." : "Analisar arquivo"}</button>
  </form>;
}
