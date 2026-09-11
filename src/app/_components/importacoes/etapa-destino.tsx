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
};

export function EtapaDestino({ sourceProfile, importId, isSavingDraft, onSaveDraft, isDiscarding, onDiscard }: EtapaDestinoProps) {
  return <StepScreen eyebrow="ETAPA 3 DE 3" title="Destino" description="Exporte a prévia ou encaminhe para revisão.">
    <PreviewExport importId={importId} sourceProfile={sourceProfile} />
    <div className={styles.stepActions}>
      {importId ? <button disabled={isDiscarding} onClick={onDiscard} type="button">{isDiscarding ? "Descartando..." : "Descartar rascunho"}</button> : null}
      <button className={styles.primaryButton} disabled={isSavingDraft || Boolean(importId)} onClick={onSaveDraft} type="button">{importId ? "Encaminhado para revisão" : isSavingDraft ? "Encaminhando..." : "Encaminhar para revisão"}</button>
    </div>
    {importId ? <MunicipalApproval importId={importId} sourceProfile={sourceProfile} /> : null}
  </StepScreen>;
}
