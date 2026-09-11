import styles from "../../page.module.css";
import { StepScreen } from "./step-screen";
import { InitialReading } from "./leitura-inicial";
import { SourcePreviewTable } from "./tabela-previa";
import { SourceProfile } from "@/lib/types/importacao";

type EtapaLeituraProps = { sourceProfile: SourceProfile; onAdvance: () => void; onSelectSheet: (sheetName: string) => void; isAnalyzing: boolean; feedbackMessage: string };

export function EtapaLeitura({ sourceProfile, onAdvance, onSelectSheet, isAnalyzing, feedbackMessage }: EtapaLeituraProps) {
  return <StepScreen eyebrow="ETAPA 2 DE 3" title="Leitura" description="Colunas, qualidade e sugestões de mapeamento.">
    <InitialReading sourceProfile={sourceProfile} />
    {sourceProfile.sheets && sourceProfile.sheets.length > 1 ? <section className={styles.analysisPanel}><div className={styles.sectionHeading}><div><h2>Selecionar aba</h2><span>Escolha a parte da planilha que deseja revisar. A quantidade exibida corresponde à aba já analisada.</span></div></div><div className={styles.sheetSelector}>{sourceProfile.sheets.map((sheet) => { const isSelected = sourceProfile.selected_sheet === sheet.name; return <button aria-pressed={isSelected} className={`${styles.sheetButton} ${isSelected ? styles.selectedSheetButton : ""}`} disabled={isAnalyzing} key={sheet.name} onClick={() => onSelectSheet(sheet.name)} type="button">{isSelected ? `${sheet.name} · ${sheet.rows.toLocaleString("pt-BR")} registros` : sheet.name}</button>; })}</div></section> : null}
    {isAnalyzing ? <p aria-live="polite" className={styles.loadingNotice}>Trocando a aba e atualizando a prévia.</p> : null}
    {feedbackMessage ? <p aria-live="assertive" className={styles.feedbackMessage}>{feedbackMessage}</p> : null}
    <SourcePreviewTable sourceProfile={sourceProfile} />
    <div className={styles.stepActions}><button className={styles.primaryButton} disabled={isAnalyzing} onClick={onAdvance} type="button">Continuar para destino</button></div>
  </StepScreen>;
}
