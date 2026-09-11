import { ChangeEvent, FormEvent } from "react";
import styles from "../../page.module.css";

type LinkImportFormProps = {
  isAnalyzing: boolean;
  sourceUrl: string;
  onSourceUrlChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function LinkImportForm({ isAnalyzing, sourceUrl, onSourceUrlChange, onSubmit }: LinkImportFormProps) {
  return <form className={styles.sourceForm} onSubmit={onSubmit}>
    <div className={styles.sectionHeading}><div><h3>Importar por link</h3><span>Cole o endereço da página da fonte ou do arquivo.</span></div></div>
    <label>Link HTTPS<input disabled={isAnalyzing} onChange={onSourceUrlChange} placeholder="https://..." type="url" value={sourceUrl} /></label>
    <p className={styles.fieldNote}>Vamos procurar um arquivo compatível, mostrar o que foi encontrado e guardar a URL como referência da fonte.</p>
    <button className={styles.primaryButton} disabled={isAnalyzing} type="submit">{isAnalyzing ? "Procurando dados..." : "Buscar no link"}</button>
  </form>;
}
