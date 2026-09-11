"use client";

import { ChangeEvent, FormEvent, useState } from "react";
import { FileUp, Database, Link2, Info } from "lucide-react";
import styles from "./page.module.css";
import { Stepper, ImportStep } from "./_components/importacoes/stepper";
import { EtapaOrigem } from "./_components/importacoes/etapa-origem";
import { EtapaLeitura } from "./_components/importacoes/etapa-leitura";
import { EtapaDestino } from "./_components/importacoes/etapa-destino";
import { DownloadCandidate, SourceProfile } from "@/lib/types/importacao";

type LinkProfileResponse = SourceProfile | { kind: string; download_candidates?: DownloadCandidate[] };

const STEPS: ImportStep[] = [
  { id: 1, title: "Origem", description: "Arquivo ou URL" },
  { id: 2, title: "Leitura", description: "Colunas e qualidade" },
  { id: 3, title: "Destino", description: "Exportar ou revisar" }
];

export default function ImportWorkspace() {
  const [currentStep, setCurrentStep] = useState(1);
  const [maxReachedStep, setMaxReachedStep] = useState(1);
  const [importMethod, setImportMethod] = useState<"file" | "link">("file");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceProfile, setSourceProfile] = useState<SourceProfile | null>(null);
  const [downloadCandidates, setDownloadCandidates] = useState<DownloadCandidate[]>([]);
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [selectedSheet, setSelectedSheet] = useState<string | null>(null);
  const [draftImportId, setDraftImportId] = useState<string | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);

  function goToStep(stepId: number) {
    setCurrentStep(stepId);
  }

  function selectSourceFile(event: ChangeEvent<HTMLInputElement>) {
    setSourceFile(event.target.files?.[0] ?? null);
    setSourceProfile(null);
    setDownloadCandidates([]);
    setAnalysisMessage("");
    setSelectedSheet(null);
    setDraftImportId(null);
  }

  function selectSourceUrl(event: ChangeEvent<HTMLInputElement>) {
    setSourceUrl(event.target.value);
  }

  function applyProfile(profilePayload: LinkProfileResponse) {
    if (profilePayload.kind === "web_page") {
      setDownloadCandidates("download_candidates" in profilePayload ? profilePayload.download_candidates ?? [] : []);
      setSourceProfile(null);
      return;
    }
    if ("file_name" in profilePayload) {
      setSourceProfile(profilePayload);
      setDownloadCandidates([]);
      setSelectedSheet(profilePayload.selected_sheet ?? null);
      setCurrentStep(2);
      setMaxReachedStep((reachedStep) => Math.max(reachedStep, 2));
    }
  }

  async function profileUploadedFile(event?: FormEvent<HTMLFormElement>, sheetName = selectedSheet) {
    event?.preventDefault();
    if (!sourceFile) {
      setAnalysisMessage("Escolha um arquivo CSV, XLSX, XLS ou JSON para iniciar a análise.");
      return;
    }
    setIsAnalyzing(true);
    setAnalysisMessage("");
    const submittedForm = new FormData();
    submittedForm.append("sourceFile", sourceFile);
    if (sheetName) submittedForm.append("sheetName", sheetName);
    try {
      const profileResponse = await fetch("/api/import-preview", { method: "POST", body: submittedForm });
      const profilePayload = await profileResponse.json();
      if (!profileResponse.ok) setAnalysisMessage(profilePayload.detail ?? profilePayload.message ?? "Não foi possível analisar o arquivo.");
      else applyProfile(profilePayload);
    } catch {
      setAnalysisMessage("Não foi possível acessar o serviço de tratamento. Confirme se ele está em execução.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  function selectWorkbookSheet(sheetName: string) {
    setSelectedSheet(sheetName);
    if (sourceFile) void profileUploadedFile(undefined, sheetName);
    else void profileSourceUrl(sourceProfile?.source_url ?? sourceUrl, sheetName);
  }

  async function profileSourceUrl(submittedUrl = sourceUrl, sheetName = selectedSheet) {
    if (!submittedUrl) {
      setAnalysisMessage("Cole um link HTTPS para iniciar a análise.");
      return;
    }
    setIsAnalyzing(true);
    setAnalysisMessage("");
    try {
      const profileResponse = await fetch("/api/link-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_url: submittedUrl, sheet_name: sheetName }) });
      const profilePayload = await profileResponse.json();
      if (!profileResponse.ok) setAnalysisMessage(profilePayload.detail ?? profilePayload.message ?? "Não foi possível analisar o link.");
      else applyProfile(profilePayload);
    } catch {
      setAnalysisMessage("Não foi possível acessar o serviço de tratamento. Confirme se ele está em execução.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  function profileSourceLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void profileSourceUrl();
  }

  function selectFoundFile(candidateUrl: string) {
    setSourceUrl(candidateUrl);
    void profileSourceUrl(candidateUrl);
  }

  async function saveDraft() {
    if (!sourceProfile) return;
    setIsSavingDraft(true);
    setAnalysisMessage("");
    try {
      const response = sourceFile
        ? await fetch("/api/import-draft", { method: "POST", body: (() => { const draftForm = new FormData(); draftForm.append("sourceFile", sourceFile); draftForm.append("title", sourceProfile.file_name); if (selectedSheet) draftForm.append("sheetName", selectedSheet); return draftForm; })() })
        : await fetch("/api/import-draft-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_url: sourceProfile.source_url, title: sourceProfile.file_name, sheet_name: selectedSheet }) });
      const payload = await response.json();
      if (!response.ok) setAnalysisMessage(payload.detail ?? payload.message ?? "Não foi possível criar o rascunho.");
      else {
        setDraftImportId(payload.import_id);
        setAnalysisMessage("");
      }
    } catch { setAnalysisMessage("Não foi possível salvar o rascunho no momento."); }
    finally { setIsSavingDraft(false); }
  }

  async function discardDraft() {
    if (!draftImportId) return;
    setIsDiscarding(true);
    try {
      const response = await fetch(`/api/imports/${draftImportId}/discard`, { method: "POST" });
      if (response.ok) setDraftImportId(null);
    } catch {
      setAnalysisMessage("Não foi possível descartar o rascunho no momento.");
    } finally {
      setIsDiscarding(false);
    }
  }

  return <div className={styles.applicationShell}>
    <aside className={styles.sidebar}>
      <div className={styles.sidebarTop}>
        <div>
          <p className={styles.productName}>DECSYS</p>
        </div>
        <nav aria-label="Navegação principal">
          <a className={styles.activeNav} href="/"><FileUp size={20} strokeWidth={1.5} />Importações</a>
          <a href="/dados-revisados"><Database size={20} strokeWidth={1.5} />Dados revisados</a>
          <a href="#fontes"><Link2 size={20} strokeWidth={1.5} />Fontes</a>
        </nav>
      </div>
    </aside>
    <main className={styles.workspaceShell}>
      <section className={styles.workspaceIntro} aria-labelledby="workspace-title">
        <p className={styles.eyebrow}>NOVA IMPORTAÇÃO</p>
        <h1 id="workspace-title">Adicionar uma fonte de dados</h1>
        <p>Registre a origem, examine a estrutura e escolha se a prévia será exportada ou encaminhada para revisão.</p>
      </section>
      <Stepper currentStep={currentStep} maxReachedStep={maxReachedStep} onSelectStep={goToStep} steps={STEPS} />
      {currentStep === 1 ? <EtapaOrigem
        analysisMessage={analysisMessage}
        downloadCandidates={downloadCandidates}
        importMethod={importMethod}
        isAnalyzing={isAnalyzing}
        onFileChange={selectSourceFile}
        onFileSubmit={profileUploadedFile}
        onImportMethodChange={setImportMethod}
        onLinkSubmit={profileSourceLink}
        onSelectFoundFile={selectFoundFile}
        onSourceUrlChange={selectSourceUrl}
        sourceUrl={sourceUrl}
      /> : null}
      {currentStep === 2 && sourceProfile ? <EtapaLeitura feedbackMessage={analysisMessage} isAnalyzing={isAnalyzing} onAdvance={() => goToStep(3)} onSelectSheet={selectWorkbookSheet} sourceProfile={sourceProfile} /> : null}
      {currentStep === 3 && sourceProfile ? <EtapaDestino feedbackMessage={analysisMessage} importId={draftImportId} isDiscarding={isDiscarding} isSavingDraft={isSavingDraft} onDiscard={discardDraft} onSaveDraft={saveDraft} sourceProfile={sourceProfile} /> : null}
    </main>
  </div>;
}
