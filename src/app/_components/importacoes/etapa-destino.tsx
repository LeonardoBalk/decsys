import { StepScreen } from "./step-screen";
import { PreviewExport } from "./exportar-previa";
import { MunicipalApproval } from "./aprovacao-municipal";
import { SourceProfile } from "@/lib/types/importacao";
import styles from "../../page.module.css";

type EtapaDestinoProps = {
  sourceProfile: SourceProfile;
  importId: string | null;
  isSavingDraft: boolean;
  onSaveDraft: () => void;
  isDiscarding: boolean;
  onDiscard: () => void;
  feedbackMessage: string;
};

export function EtapaDestino({ sourceProfile, importId, isSavingDraft, onSaveDraft, isDiscarding, onDiscard, feedbackMessage }: EtapaDestinoProps) {
  return <StepScreen eyebrow="ETAPA 3 DE 3" title="Destino" description="Exporte a prévia ou encaminhe para revisão.">
    <PreviewExport importId={importId} sourceProfile={sourceProfile} />
    <section className={styles.processHint}><strong>{importId ? "Rascunho salvo para revisão" : "Antes de encaminhar"}</strong><p>{importId ? "A base completa foi guardada com a fonte original. Ela ainda não aparece em painéis: alguém precisa revisar as colunas e aprovar o uso dos dados." : "Encaminhar guarda a base e a origem para revisão. Essa ação não publica dados automaticamente em nenhum painel."}</p></section>
    {isSavingDraft ? <p aria-live="polite" className={styles.loadingNotice}>Guardando o arquivo, suas linhas e a referência da fonte.</p> : null}
    {feedbackMessage ? <p aria-live="assertive" className={styles.feedbackMessage}>{feedbackMessage}</p> : null}
    <div className={styles.stepActions}>
      {importId ? <button disabled={isDiscarding} onClick={onDiscard} type="button">{isDiscarding ? "Descartando..." : "Descartar rascunho"}</button> : null}
      <button className={styles.primaryButton} disabled={isSavingDraft || Boolean(importId)} onClick={onSaveDraft} type="button">{importId ? "Encaminhado para revisão" : isSavingDraft ? "Encaminhando..." : "Encaminhar para revisão"}</button>
    </div>
    {importId ? <MunicipalApproval importId={importId} sourceProfile={sourceProfile} /> : null}
  </StepScreen>;
}
