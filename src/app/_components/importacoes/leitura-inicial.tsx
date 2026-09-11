import styles from "../../page.module.css";
import { SourceProfile } from "@/lib/types/importacao";

type InitialReadingProps = { sourceProfile: SourceProfile };

export function InitialReading({ sourceProfile }: InitialReadingProps) {
  return <section className={styles.analysisPanel} aria-live="polite">
    <div className={styles.sectionHeading}><div><h2>Leitura inicial</h2><span>{sourceProfile.rows.toLocaleString("pt-BR")} linhas reconhecidas</span></div></div>
    <div className={styles.profileSummary}>
      <p className={styles.fileName}>{sourceProfile.file_name}</p>
      {sourceProfile.source_url ? <a className={styles.sourceLink} href={sourceProfile.source_url} rel="noreferrer" target="_blank">Abrir origem</a> : null}
      <dl><div><dt>Colunas</dt><dd>{sourceProfile.columns.length}</dd></div><div><dt>Código municipal</dt><dd>{sourceProfile.suggestions.municipality_code ?? "não reconhecido"}</dd></div><div><dt>Ano</dt><dd>{sourceProfile.suggestions.reference_year ?? "não reconhecido"}</dd></div><div><dt>Valor</dt><dd>{sourceProfile.suggestions.value ?? "revisar"}</dd></div></dl>
      <p className={styles.profileGuidance}>{sourceProfile.agent_assessment?.summary ?? "A próxima etapa vinculará essas colunas a um indicador da matriz e executará as validações antes da aprovação."}</p>
    </div>
  </section>;
}
