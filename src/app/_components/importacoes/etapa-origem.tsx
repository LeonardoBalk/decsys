import { ChangeEvent, FormEvent } from "react";
import styles from "../../page.module.css";
import { StepScreen } from "./step-screen";
import { FileImportForm } from "./formulario-arquivo";
import { LinkImportForm } from "./formulario-link";
import { FoundFiles } from "./arquivos-encontrados";
import { DownloadCandidate } from "@/lib/types/importacao";

type EtapaOrigemProps = {
  importMethod: "file" | "link";
  onImportMethodChange: (method: "file" | "link") => void;
  isAnalyzing: boolean;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onFileSubmit: (event: FormEvent<HTMLFormElement>) => void;
  sourceUrl: string;
  onSourceUrlChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onLinkSubmit: (event: FormEvent<HTMLFormElement>) => void;
  downloadCandidates: DownloadCandidate[];
  onSelectFoundFile: (sourceUrl: string) => void;
  analysisMessage: string;
};

export function EtapaOrigem({
  importMethod,
  onImportMethodChange,
  isAnalyzing,
  onFileChange,
  onFileSubmit,
  sourceUrl,
  onSourceUrlChange,
  onLinkSubmit,
  downloadCandidates,
  onSelectFoundFile,
  analysisMessage
}: EtapaOrigemProps) {
  return <StepScreen eyebrow="ETAPA 1 DE 3" title="Origem" description="Como você quer fornecer a base?">
    <div className={styles.sourceCard}>
      <div className={styles.importMethodTabs} role="tablist" aria-label="Forma de fornecer a fonte">
        <button aria-selected={importMethod === "file"} className={importMethod === "file" ? styles.selectedMethod : ""} onClick={() => onImportMethodChange("file")} role="tab" type="button">Arquivo local</button>
        <button aria-selected={importMethod === "link"} className={importMethod === "link" ? styles.selectedMethod : ""} onClick={() => onImportMethodChange("link")} role="tab" type="button">Link da fonte</button>
      </div>
      {importMethod === "file"
        ? <FileImportForm isAnalyzing={isAnalyzing} onFileChange={onFileChange} onSubmit={onFileSubmit} />
        : <LinkImportForm isAnalyzing={isAnalyzing} onSourceUrlChange={onSourceUrlChange} onSubmit={onLinkSubmit} sourceUrl={sourceUrl} />}
    </div>
    <section className={styles.processHint}><strong>O que acontece depois?</strong><p>O Decsys identifica colunas e possíveis problemas. Você confere uma prévia antes de salvar, exportar ou encaminhar qualquer dado.</p></section>
    {isAnalyzing ? <p aria-live="polite" className={styles.loadingNotice}>Estamos lendo a estrutura da fonte. Isso pode levar alguns instantes em planilhas grandes.</p> : null}
    {analysisMessage ? <p aria-live="assertive" className={styles.feedbackMessage}>{analysisMessage}</p> : null}
    <FoundFiles candidates={downloadCandidates} onSelect={onSelectFoundFile} />
  </StepScreen>;
}
