"use client";

import { ChangeEvent, FormEvent, Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import styles from "./page.module.css";
import { Stepper, ImportStep } from "./_components/importacoes/stepper";
import { EtapaOrigem } from "./_components/importacoes/etapa-origem";
import { EtapaLeitura } from "./_components/importacoes/etapa-leitura";
import { EtapaDestino } from "./_components/importacoes/etapa-destino";
import { DownloadCandidate, SourceProfile } from "@/lib/types/importacao";
import { importErrorMessage } from "@/lib/import-error-message";
import { setUnsavedChanges } from "@/lib/unsaved-changes";

type LinkProfileResponse = SourceProfile | { kind: string; download_candidates?: DownloadCandidate[] };

const STEPS: ImportStep[] = [
  { id: 1, title: "Origem", description: "Arquivo ou URL" },
  { id: 2, title: "Leitura", description: "Colunas e qualidade" },
  { id: 3, title: "Destino", description: "Exportar ou revisar" }
];

const UNSAVED_ANALYSIS_MESSAGE = "A análise desta fonte ainda não foi importada. Se sair agora, será preciso enviar o arquivo de novo. Deseja sair mesmo assim?";

function replaceImportIdInUrl(importId: string | null) {
  const resumeUrl = new URL(window.location.href);
  if (importId) resumeUrl.searchParams.set("importId", importId);
  else resumeUrl.searchParams.delete("importId");
  window.history.replaceState(window.history.state, "", resumeUrl);
}

export default function ImportPage() {
  return <Suspense fallback={<main className={styles.workspaceShell} />}><ImportWorkspace /></Suspense>;
}

function ImportWorkspace() {
  const importIdParam = useSearchParams().get("importId");
  const knownImportId = useRef<string | null>(null);
  const [currentStep, setCurrentStep] = useState(1);
  const [maxReachedStep, setMaxReachedStep] = useState(1);
  const [importMethod, setImportMethod] = useState<"file" | "link">("file");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceProfile, setSourceProfile] = useState<SourceProfile | null>(null);
  const [uploadToken, setUploadToken] = useState<string | null>(null);
  const [downloadCandidates, setDownloadCandidates] = useState<DownloadCandidate[]>([]);
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [analysisMessageKind, setAnalysisMessageKind] = useState<"error" | "success">("error");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [selectedSheet, setSelectedSheet] = useState<string | null>(null);
  const [draftImportId, setDraftImportId] = useState<string | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);

  function rememberImportId(importId: string | null) {
    knownImportId.current = importId;
    setDraftImportId(importId);
    replaceImportIdInUrl(importId);
  }

  function resetWorkspace() {
    knownImportId.current = null;
    setCurrentStep(1);
    setMaxReachedStep(1);
    setSourceFile(null);
    setSourceUrl("");
    setSourceProfile(null);
    setUploadToken(null);
    setDownloadCandidates([]);
    setAnalysisMessage("");
    setSelectedSheet(null);
    setDraftImportId(null);
  }

  useEffect(() => {
    if (importIdParam === knownImportId.current) return;
    if (!importIdParam) {
      resetWorkspace();
      return;
    }
    knownImportId.current = importIdParam;
    let cancelled = false;
    fetch(`/api/imports/${encodeURIComponent(importIdParam)}/resume`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await importErrorMessage(response, "Não foi possível reabrir essa importação."));
        return response.json();
      })
      .then((payload) => {
        if (cancelled) return;
        setDraftImportId(payload.import_id);
        setSourceProfile(payload.profile);
        setUploadToken(null);
        setSelectedSheet(payload.profile.selected_sheet ?? null);
        setCurrentStep(3);
        setMaxReachedStep(3);
        setAnalysisMessageKind("success");
        setAnalysisMessage("Importação salva reaberta. Escolha a aba que quer revisar; as linhas existentes não foram alteradas.");
      })
      .catch((resumeError: unknown) => {
        if (cancelled) return;
        knownImportId.current = null;
        setAnalysisMessageKind("error");
        setAnalysisMessage(resumeError instanceof Error ? resumeError.message : "Não foi possível reabrir essa importação.");
      });
    return () => { cancelled = true; };
  }, [importIdParam]);

  const hasUnsavedAnalysis = Boolean(sourceProfile && !draftImportId);
  useEffect(() => {
    if (!hasUnsavedAnalysis) {
      setUnsavedChanges(null);
      return;
    }
    setUnsavedChanges(UNSAVED_ANALYSIS_MESSAGE);
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => {
      setUnsavedChanges(null);
      window.removeEventListener("beforeunload", warnBeforeUnload);
    };
  }, [hasUnsavedAnalysis]);

  function goToStep(stepId: number) {
    setAnalysisMessage("");
    setCurrentStep(stepId);
  }

  function clearAnalyzedSource() {
    setSourceProfile(null);
    setUploadToken(null);
    setDownloadCandidates([]);
    setAnalysisMessage("");
    setSelectedSheet(null);
    setMaxReachedStep(1);
    if (draftImportId) rememberImportId(null);
  }

  function selectSourceFile(event: ChangeEvent<HTMLInputElement>) {
    setSourceFile(event.target.files?.[0] ?? null);
    clearAnalyzedSource();
  }

  function selectSourceUrl(event: ChangeEvent<HTMLInputElement>) {
    setSourceUrl(event.target.value);
    clearAnalyzedSource();
  }

  function applyProfile(profilePayload: LinkProfileResponse) {
    if (profilePayload.kind === "web_page") {
      const foundCandidates = "download_candidates" in profilePayload ? profilePayload.download_candidates ?? [] : [];
      setDownloadCandidates(foundCandidates);
      setSourceProfile(null);
      setUploadToken(null);
      setAnalysisMessageKind(foundCandidates.length ? "success" : "error");
      setAnalysisMessage(foundCandidates.length
        ? `Encontramos ${foundCandidates.length.toLocaleString("pt-BR")} arquivo(s) nesta página. Escolha abaixo qual deseja analisar.`
        : "Esta página não ofereceu um arquivo que o Decsys consiga ler diretamente. Procure o link de download dos dados, como CSV ou XLSX.");
      return;
    }
    if ("file_name" in profilePayload) {
      setSourceProfile(profilePayload);
      setUploadToken(profilePayload.upload_token ?? null);
      setAnalysisMessage("");
      setDownloadCandidates([]);
      setSelectedSheet(profilePayload.selected_sheet ?? null);
      setCurrentStep(2);
      setMaxReachedStep((reachedStep) => Math.max(reachedStep, 2));
    }
  }

  async function requestFileProfile(sheetName: string | null, reusableToken: string | null): Promise<Response> {
    const submittedForm = new FormData();
    if (reusableToken) submittedForm.append("uploadToken", reusableToken);
    else if (sourceFile) submittedForm.append("sourceFile", sourceFile);
    if (sheetName) submittedForm.append("sheetName", sheetName);
    const profileResponse = await fetch("/api/import-preview", { method: "POST", body: submittedForm });
    if (profileResponse.status === 410 && reusableToken && sourceFile) return requestFileProfile(sheetName, null);
    return profileResponse;
  }

  async function profileUploadedFile(event?: FormEvent<HTMLFormElement>, sheetName = selectedSheet, reusableToken: string | null = null) {
    event?.preventDefault();
    if (!sourceFile && !reusableToken) {
      setAnalysisMessageKind("error");
      setAnalysisMessage("Escolha um arquivo CSV, XLSX, XLS ou JSON para iniciar a análise.");
      return;
    }
    setIsAnalyzing(true);
    setAnalysisMessage("");
    try {
      const profileResponse = await requestFileProfile(sheetName, reusableToken);
      if (!profileResponse.ok) {
        setAnalysisMessageKind("error");
        setAnalysisMessage(await importErrorMessage(profileResponse, "Não conseguimos ler este arquivo. Confira o formato e tente novamente."));
        setSelectedSheet(sourceProfile?.selected_sheet ?? null);
      }
      else applyProfile(await profileResponse.json());
    } catch {
      setAnalysisMessageKind("error");
      setAnalysisMessage("Não conseguimos analisar o arquivo agora. Confira se o serviço de leitura está iniciado e tente novamente; o arquivo original continua no seu computador.");
      setSelectedSheet(sourceProfile?.selected_sheet ?? null);
    } finally {
      setIsAnalyzing(false);
    }
  }

  function selectWorkbookSheet(sheetName: string) {
    if (sourceFile) void profileUploadedFile(undefined, sheetName, uploadToken);
    else void profileSourceUrl(sourceProfile?.source_url ?? sourceUrl, sheetName, uploadToken);
  }

  async function requestLinkProfile(submittedUrl: string, sheetName: string | null, reusableToken: string | null): Promise<Response> {
    const profileResponse = await fetch("/api/link-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_url: submittedUrl, sheet_name: sheetName, upload_token: reusableToken }) });
    if (profileResponse.status === 410 && reusableToken) return requestLinkProfile(submittedUrl, sheetName, null);
    return profileResponse;
  }

  async function profileSourceUrl(submittedUrl = sourceUrl, sheetName = selectedSheet, reusableToken: string | null = null) {
    if (!submittedUrl) {
      setAnalysisMessageKind("error");
      setAnalysisMessage("Cole um link HTTPS para iniciar a análise.");
      return;
    }
    setIsAnalyzing(true);
    setAnalysisMessage("");
    try {
      const profileResponse = await requestLinkProfile(submittedUrl, sheetName, reusableToken);
      if (!profileResponse.ok) {
        setAnalysisMessageKind("error");
        setAnalysisMessage(await importErrorMessage(profileResponse, "Não conseguimos ler esse link. Confira se ele abre sem login e tente novamente."));
        setSelectedSheet(sourceProfile?.selected_sheet ?? null);
      }
      else applyProfile(await profileResponse.json());
    } catch {
      setAnalysisMessageKind("error");
      setAnalysisMessage("Não conseguimos abrir esse link agora. Verifique sua conexão e tente novamente.");
      setSelectedSheet(sourceProfile?.selected_sheet ?? null);
    } finally {
      setIsAnalyzing(false);
    }
  }

  function profileSourceLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void profileSourceUrl(sourceUrl, null);
  }

  function selectFoundFile(candidateUrl: string) {
    setSourceUrl(candidateUrl);
    void profileSourceUrl(candidateUrl, null);
  }

  async function requestDraft(profile: SourceProfile, includeAllSheets: boolean, reusableToken: string | null): Promise<Response> {
    let draftResponse: Response;
    if (sourceFile || (reusableToken && !profile.source_url)) {
      const draftForm = new FormData();
      if (reusableToken) draftForm.append("uploadToken", reusableToken);
      else if (sourceFile) draftForm.append("sourceFile", sourceFile);
      draftForm.append("title", profile.file_name);
      draftForm.append("include_all_sheets", String(includeAllSheets));
      if (selectedSheet) draftForm.append("sheetName", selectedSheet);
      draftResponse = await fetch("/api/import-draft", { method: "POST", body: draftForm });
    } else {
      draftResponse = await fetch("/api/import-draft-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_url: profile.source_url, title: profile.file_name, sheet_name: selectedSheet, include_all_sheets: includeAllSheets, upload_token: reusableToken }) });
    }
    if (draftResponse.status === 410 && reusableToken) return requestDraft(profile, includeAllSheets, null);
    return draftResponse;
  }

  async function saveDraft(includeAllSheets: boolean) {
    if (!sourceProfile) return;
    setIsSavingDraft(true);
    setAnalysisMessage("");
    try {
      const response = await requestDraft(sourceProfile, includeAllSheets, uploadToken);
      if (!response.ok) {
        setAnalysisMessageKind("error");
        setAnalysisMessage(await importErrorMessage(response, "Não conseguimos guardar essa fonte. Tente novamente."));
      }
      else {
        const payload = await response.json();
        rememberImportId(payload.import_id);
        const importedRows = Number(payload.total_rows ?? sourceProfile.rows);
        const importedSheetCount = Array.isArray(payload.imported_sheets) ? payload.imported_sheets.length : 1;
        setAnalysisMessageKind("success");
        setAnalysisMessage(includeAllSheets && sourceProfile.sheets && sourceProfile.sheets.length > 1
          ? `${importedRows.toLocaleString("pt-BR")} registros de ${importedSheetCount.toLocaleString("pt-BR")} abas foram guardados para revisão. Cada aba continua separada.`
          : `${importedRows.toLocaleString("pt-BR")} registros foram guardados para revisão. O arquivo original foi mantido.`);
      }
    } catch {
      setAnalysisMessageKind("error");
      setAnalysisMessage("Não foi possível salvar a importação. Seus dados continuam no arquivo original; tente novamente.");
    }
    finally { setIsSavingDraft(false); }
  }

  async function discardDraft() {
    if (!draftImportId) return;
    if (!window.confirm("Descartar este rascunho? As linhas importadas e o arquivo guardado serão removidos do Decsys.")) return;
    setIsDiscarding(true);
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(draftImportId)}/discard`, { method: "POST" });
      if (response.ok) {
        rememberImportId(null);
        setAnalysisMessageKind("success");
        setAnalysisMessage("Rascunho descartado. O arquivo original no seu computador não foi alterado.");
      } else {
        setAnalysisMessageKind("error");
        setAnalysisMessage(await importErrorMessage(response, "Não conseguimos descartar essa importação. Tente novamente."));
      }
    } catch {
      setAnalysisMessageKind("error");
      setAnalysisMessage("Não foi possível descartar o rascunho no momento.");
    } finally {
      setIsDiscarding(false);
    }
  }

  return <main className={styles.workspaceShell}>
    <section className={styles.workspaceIntro} aria-labelledby="workspace-title">
      <p className={styles.eyebrow}>NOVA IMPORTAÇÃO</p>
      <h1 id="workspace-title">Adicionar uma fonte de dados</h1>
      <p>Registre a origem, examine a estrutura e escolha se a prévia será exportada ou encaminhada para revisão.</p>
    </section>
    <Stepper currentStep={currentStep} maxReachedStep={sourceProfile ? maxReachedStep : 1} onSelectStep={goToStep} steps={STEPS} />
    {currentStep === 1 || !sourceProfile ? <EtapaOrigem
      analysisMessage={analysisMessage}
      downloadCandidates={downloadCandidates}
      importMethod={importMethod}
      isAnalyzing={isAnalyzing}
      analysisMessageKind={analysisMessageKind}
      onFileChange={selectSourceFile}
      onFileSubmit={profileUploadedFile}
      onImportMethodChange={setImportMethod}
      onLinkSubmit={profileSourceLink}
      onSelectFoundFile={selectFoundFile}
      onSourceUrlChange={selectSourceUrl}
      sourceUrl={sourceUrl}
    /> : null}
    {currentStep === 2 && sourceProfile ? <EtapaLeitura feedbackMessage={analysisMessage} feedbackMessageKind={analysisMessageKind} isAnalyzing={isAnalyzing} onAdvance={() => goToStep(3)} onSelectSheet={selectWorkbookSheet} sourceProfile={sourceProfile} /> : null}
    {currentStep === 3 && sourceProfile ? <EtapaDestino feedbackMessage={analysisMessage} feedbackMessageKind={analysisMessageKind} importId={draftImportId} isDiscarding={isDiscarding} isSavingDraft={isSavingDraft} onDiscard={discardDraft} onSaveDraft={saveDraft} sourceProfile={sourceProfile} /> : null}
  </main>;
}
