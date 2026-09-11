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
    <div className={styles.sectionHeading}><div><h3>Importar por link</h3><span>Arquivo direto ou página que ofereça um download.</span></div></div>
    <label>Link HTTPS<input onChange={onSourceUrlChange} placeholder="https://..." type="url" value={sourceUrl} /></label>
    <p className={styles.fieldNote}>O Decsys baixa uma cópia temporária, localiza arquivos compatíveis e registra a URL de origem.</p>
    <button className={styles.primaryButton} disabled={isAnalyzing} type="submit">Buscar no link</button>
  </form>;
}
