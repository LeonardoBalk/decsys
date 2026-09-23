import { StepScreen } from "./step-screen";
import { PreviewExport } from "./exportar-previa";
import { MunicipalApproval } from "./aprovacao-municipal";
import { SourceProfile } from "@/lib/types/importacao";
import styles from "../../page.module.css";
import { StatusNotice } from "../status-notice";

type EtapaDestinoProps = {
  sourceProfile: SourceProfile;
  importId: string | null;
  isSavingDraft: boolean;
  onSaveDraft: (includeAllSheets: boolean) => void;
  isDiscarding: boolean;
  onDiscard: () => void;
  feedbackMessage: string;
  feedbackMessageKind: "error" | "success";
};

export function EtapaDestino({ sourceProfile, importId, isSavingDraft, onSaveDraft, isDiscarding, onDiscard, feedbackMessage, feedbackMessageKind }: EtapaDestinoProps) {
  return <StepScreen eyebrow="ETAPA 3 DE 3" title="Destino" description="Exporte a prévia ou importe a tabela inteira para revisão.">
    <PreviewExport importId={importId} sourceProfile={sourceProfile} />
    <section className={styles.processHint}><strong>{importId ? "Planilha importada" : "Escolha o alcance da importação"}</strong><p>{importId ? "A fonte original e os registros importados foram guardados. Para tratar dados municipais, a aba revisada continua selecionada separadamente." : sourceProfile.sheets && sourceProfile.sheets.length > 1 ? "Você pode importar apenas a aba em revisão ou todas as abas legíveis. Cada aba permanece identificada para tratamento posterior." : `A prévia mostra uma amostra, mas a importação gravará os ${sourceProfile.rows.toLocaleString("pt-BR")} registros reconhecidos, junto com a fonte original.`}</p></section>
    {isSavingDraft ? <StatusNotice variant="loading">Guardando o arquivo, as linhas e a referência da fonte.</StatusNotice> : null}
    {isDiscarding ? <StatusNotice variant="loading">Descartando o rascunho.</StatusNotice> : null}
    {feedbackMessage ? <StatusNotice variant={feedbackMessageKind}>{feedbackMessage}</StatusNotice> : null}
    <div className={styles.stepActions}>
      {importId ? <button disabled={isDiscarding} onClick={onDiscard} type="button">{isDiscarding ? "Descartando..." : "Descartar rascunho"}</button> : null}
      {sourceProfile.sheets && sourceProfile.sheets.length > 1 && !importId ? <button disabled={isSavingDraft} onClick={() => onSaveDraft(false)} type="button">Importar aba em revisão</button> : null}
      <button className={styles.primaryButton} disabled={isSavingDraft || Boolean(importId)} onClick={() => onSaveDraft(Boolean(sourceProfile.sheets && sourceProfile.sheets.length > 1))} type="button">{importId ? "Planilha importada" : isSavingDraft ? "Importando..." : sourceProfile.sheets && sourceProfile.sheets.length > 1 ? "Importar todas as abas" : "Importar tabela completa"}</button>
    </div>
    {importId ? <MunicipalApproval importId={importId} sourceProfile={sourceProfile} /> : null}
  </StepScreen>;
}
