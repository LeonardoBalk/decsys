import { useEffect, useState } from "react";
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
  const [activeProfile, setActiveProfile] = useState(sourceProfile);
  const [availableSheets, setAvailableSheets] = useState(sourceProfile.sheets ?? []);
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);
  const [isAddingSheets, setIsAddingSheets] = useState(false);
  const [isLoadingSavedSheets, setIsLoadingSavedSheets] = useState(false);
  const [sheetMessage, setSheetMessage] = useState("");
  const [sheetMessageKind, setSheetMessageKind] = useState<"error" | "success">("error");

  useEffect(() => {
    setActiveProfile(sourceProfile);
    setAvailableSheets(sourceProfile.sheets ?? []);
  }, [sourceProfile]);

  useEffect(() => {
    if (!importId) return;
    const selectedSheet = sourceProfile.selected_sheet;
    let cancelled = false;
    setIsLoadingSavedSheets(true);
    const query = selectedSheet ? `?sheet_name=${encodeURIComponent(selectedSheet)}` : "";
    fetch(`/api/imports/${importId}/sheets${query}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Não conseguimos carregar as abas guardadas. Os dados importados continuam salvos.");
        return response.json();
      })
      .then((payload) => {
        if (cancelled) return;
        setAvailableSheets(payload.sheets ?? sourceProfile.sheets ?? []);
        if (payload.profile) setActiveProfile({ ...sourceProfile, ...payload.profile, sheets: payload.sheets, selected_sheet: selectedSheet });
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setSheetMessage(loadError instanceof Error ? loadError.message : "Não conseguimos carregar as abas guardadas.");
      })
      .finally(() => {
        if (!cancelled) setIsLoadingSavedSheets(false);
      });
    return () => { cancelled = true; };
  }, [importId, sourceProfile]);

  async function selectSavedSheet(sheetName: string) {
    if (!importId || sheetName === activeProfile.selected_sheet) return;
    setIsLoadingSheet(true);
    setSheetMessage("");
    try {
      const response = await fetch(`/api/imports/${importId}/sheets?sheet_name=${encodeURIComponent(sheetName)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Não foi possível abrir a prévia dessa aba. Tente novamente.");
      const payload = await response.json();
      if (!payload.profile) throw new Error("Esta aba foi guardada sem linhas legíveis para mostrar.");
      setAvailableSheets(payload.sheets ?? availableSheets);
      setActiveProfile({ ...sourceProfile, ...payload.profile, sheets: payload.sheets, selected_sheet: sheetName });
    } catch (loadError) {
      setSheetMessage(loadError instanceof Error ? loadError.message : "Não foi possível abrir a prévia dessa aba.");
    } finally {
      setIsLoadingSheet(false);
    }
  }

  async function includeRemainingSheets() {
    if (!importId) return;
    setIsAddingSheets(true);
    setSheetMessage("");
    try {
      const includeResponse = await fetch(`/api/imports/${importId}/include-sheets`, { method: "POST" });
      if (!includeResponse.ok) throw new Error("Não conseguimos importar as abas restantes. As linhas que já estavam guardadas continuam intactas.");
      const includePayload = await includeResponse.json();
      const selectedSheet = activeProfile.selected_sheet;
      const query = selectedSheet ? `?sheet_name=${encodeURIComponent(selectedSheet)}` : "";
      const sheetsResponse = await fetch(`/api/imports/${importId}/sheets${query}`, { cache: "no-store" });
      if (!sheetsResponse.ok) throw new Error("As abas foram preparadas, mas não conseguimos atualizar a lista agora. Recarregue a página para conferir.");
      const sheetsPayload = await sheetsResponse.json();
      setAvailableSheets(sheetsPayload.sheets ?? []);
      if (sheetsPayload.profile) setActiveProfile({ ...activeProfile, ...sheetsPayload.profile, sheets: sheetsPayload.sheets });
      setSheetMessageKind("success");
      setSheetMessage(includePayload.added_rows ? `${includePayload.added_rows.toLocaleString("pt-BR")} linhas de ${includePayload.added_sheets.length.toLocaleString("pt-BR")} abas adicionais foram importadas. Agora você pode escolher cada aba para revisar.` : "Todas as abas legíveis já estavam importadas.");
    } catch (loadError) {
      setSheetMessageKind("error");
      setSheetMessage(loadError instanceof Error ? loadError.message : "Não foi possível importar as abas restantes.");
    } finally {
      setIsAddingSheets(false);
    }
  }

  const activeSheet = availableSheets.find((sheet) => sheet.name === activeProfile.selected_sheet);

  return <StepScreen eyebrow="ETAPA 3 DE 3" title="Destino" description="Exporte a prévia ou importe a tabela inteira para revisão.">
    <PreviewExport importId={importId} sourceProfile={activeProfile} />
    <section className={styles.processHint}><strong>{importId ? "Importação salva para revisão" : "Escolha o alcance da importação"}</strong><p>{importId ? "O arquivo original e as linhas importadas estão guardados. Escolha abaixo qual aba quer revisar; trocar de aba aqui não altera os dados armazenados." : sourceProfile.sheets && sourceProfile.sheets.length > 1 ? "Você pode importar apenas a aba em revisão ou todas as abas legíveis. Cada aba permanece identificada para tratamento posterior." : `A prévia mostra uma amostra, mas a importação gravará os ${sourceProfile.rows.toLocaleString("pt-BR")} registros reconhecidos, junto com a fonte original.`}</p></section>
    {importId && availableSheets.length > 1 ? <section className={styles.analysisPanel}>
      <div className={styles.sectionHeading}><div><h2>Escolha a aba para revisar</h2><span>Cada aba é independente. Se uma não tiver municípios, selecione outra que contenha essa informação.</span></div></div>
      {isLoadingSavedSheets ? <StatusNotice variant="loading">Conferindo quais abas já foram importadas.</StatusNotice> : null}
      {!isLoadingSavedSheets && availableSheets.some((sheet) => !sheet.imported) ? <div className={styles.processHint}><strong>{availableSheets.filter((sheet) => sheet.imported).length} de {availableSheets.length} abas importadas</strong><p>As outras {availableSheets.filter((sheet) => !sheet.imported).length} abas ainda estão apenas no arquivo original. Você pode acrescentá-las agora na mesma importação.</p><button disabled={isAddingSheets || isLoadingSheet} onClick={() => void includeRemainingSheets()} type="button">{isAddingSheets ? "Importando abas..." : "Importar abas restantes"}</button></div> : null}
      <div className={styles.sheetSelector}>{availableSheets.map((sheet) => <button aria-pressed={activeProfile.selected_sheet === sheet.name} className={`${styles.sheetButton} ${activeProfile.selected_sheet === sheet.name ? styles.selectedSheetButton : ""}`} disabled={isLoadingSheet || !sheet.imported} key={sheet.name} onClick={() => void selectSavedSheet(sheet.name)} type="button"><strong>{sheet.name}</strong><span>{sheet.imported ? `${sheet.rows.toLocaleString("pt-BR")} linhas · ${sheet.columns.toLocaleString("pt-BR")} colunas` : "Ainda não importada"}</span></button>)}</div>
      {isLoadingSheet ? <StatusNotice variant="loading">Carregando colunas e prévia da aba escolhida.</StatusNotice> : null}
      {isAddingSheets ? <StatusNotice variant="loading">Abrindo o arquivo original e guardando as abas legíveis que ainda faltam.</StatusNotice> : null}
      {sheetMessage ? <StatusNotice variant={sheetMessageKind}>{sheetMessage}</StatusNotice> : null}
    </section> : null}
    {importId && activeSheet ? <p className={styles.fieldNote}>Aba em revisão: <strong>{activeSheet.name}</strong> · {activeSheet.rows.toLocaleString("pt-BR")} linhas · {activeSheet.columns.toLocaleString("pt-BR")} colunas.</p> : null}
    {isSavingDraft ? <StatusNotice variant="loading">Guardando o arquivo, as linhas e a referência da fonte.</StatusNotice> : null}
    {isDiscarding ? <StatusNotice variant="loading">Descartando o rascunho.</StatusNotice> : null}
    {feedbackMessage ? <StatusNotice variant={feedbackMessageKind}>{feedbackMessage}</StatusNotice> : null}
    <div className={styles.stepActions}>
      {importId ? <button disabled={isDiscarding} onClick={onDiscard} type="button">{isDiscarding ? "Descartando..." : "Descartar rascunho"}</button> : null}
      {sourceProfile.sheets && sourceProfile.sheets.length > 1 && !importId ? <button disabled={isSavingDraft} onClick={() => onSaveDraft(false)} type="button">Importar aba em revisão</button> : null}
      <button className={styles.primaryButton} disabled={isSavingDraft || Boolean(importId)} onClick={() => onSaveDraft(Boolean(sourceProfile.sheets && sourceProfile.sheets.length > 1))} type="button">{importId ? "Planilha importada" : isSavingDraft ? "Importando..." : sourceProfile.sheets && sourceProfile.sheets.length > 1 ? "Importar todas as abas" : "Importar tabela completa"}</button>
    </div>
    {importId ? <MunicipalApproval importId={importId} onSheetCreated={(createdSheet) => void selectSavedSheet(createdSheet)} sourceProfile={activeProfile} /> : null}
  </StepScreen>;
}
