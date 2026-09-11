import styles from "../../page.module.css";
import { StepScreen } from "./step-screen";
import { InitialReading } from "./leitura-inicial";
import { SourcePreviewTable } from "./tabela-previa";
import { SourceProfile } from "@/lib/types/importacao";

type EtapaLeituraProps = { sourceProfile: SourceProfile; onAdvance: () => void; onSelectSheet: (sheetName: string) => void };

export function EtapaLeitura({ sourceProfile, onAdvance, onSelectSheet }: EtapaLeituraProps) {
  return <StepScreen eyebrow="ETAPA 2 DE 3" title="Leitura" description="Colunas, qualidade e sugestões de mapeamento.">
    <InitialReading sourceProfile={sourceProfile} />
    {sourceProfile.sheets && sourceProfile.sheets.length > 1 ? <section className={styles.analysisPanel}><h2>Selecionar aba</h2><div className={styles.exportActions}>{sourceProfile.sheets.map((sheet) => <button className={sourceProfile.selected_sheet === sheet.name ? styles.primaryButton : ""} key={sheet.name} onClick={() => onSelectSheet(sheet.name)} type="button">{sheet.name} · {sheet.rows} linhas</button>)}</div></section> : null}
    <SourcePreviewTable sourceProfile={sourceProfile} />
    <div className={styles.stepActions}><button className={styles.primaryButton} onClick={onAdvance} type="button">Avançar</button></div>
  </StepScreen>;
}
