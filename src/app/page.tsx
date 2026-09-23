"use client";

import { ChangeEvent, FormEvent, useState } from "react";
import { ChartNoAxesCombined, FileUp, Database, ListTree } from "lucide-react";
import styles from "./page.module.css";
import { Stepper, ImportStep } from "./_components/importacoes/stepper";
import { EtapaOrigem } from "./_components/importacoes/etapa-origem";
import { EtapaLeitura } from "./_components/importacoes/etapa-leitura";
import { EtapaDestino } from "./_components/importacoes/etapa-destino";
import { DownloadCandidate, SourceProfile } from "@/lib/types/importacao";
import { importErrorMessage } from "@/lib/import-error-message";

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
  const [analysisMessageKind, setAnalysisMessageKind] = useState<"error" | "success">("error");
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
    setSourceProfile(null);
    setDownloadCandidates([]);
    setAnalysisMessage("");
    setSelectedSheet(null);
    setDraftImportId(null);
  }

  function applyProfile(profilePayload: LinkProfileResponse) {
    if (profilePayload.kind === "web_page") {
      const foundCandidates = "download_candidates" in profilePayload ? profilePayload.download_candidates ?? [] : [];
      setDownloadCandidates(foundCandidates);
      setSourceProfile(null);
      setAnalysisMessageKind(foundCandidates.length ? "success" : "error");
      setAnalysisMessage(foundCandidates.length
        ? `Encontramos ${foundCandidates.length.toLocaleString("pt-BR")} arquivo(s) nesta página. Escolha abaixo qual deseja analisar.`
        : "Esta página não ofereceu um arquivo que o Decsys consiga ler diretamente. Procure o link de download dos dados, como CSV ou XLSX.");
      return;
    }
    if ("file_name" in profilePayload) {
      setSourceProfile(profilePayload);
      setAnalysisMessage("");
      setDownloadCandidates([]);
      setSelectedSheet(profilePayload.selected_sheet ?? null);
      setCurrentStep(2);
      setMaxReachedStep((reachedStep) => Math.max(reachedStep, 2));
    }
  }

  async function profileUploadedFile(event?: FormEvent<HTMLFormElement>, sheetName = selectedSheet) {
    event?.preventDefault();
    if (!sourceFile) {
      setAnalysisMessageKind("error");
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
      if (!profileResponse.ok) {
        setAnalysisMessageKind("error");
        setAnalysisMessage(await importErrorMessage(profileResponse, "Não conseguimos ler este arquivo. Confira o formato e tente novamente."));
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
    if (sourceFile) void profileUploadedFile(undefined, sheetName);
    else void profileSourceUrl(sourceProfile?.source_url ?? sourceUrl, sheetName);
  }

  async function profileSourceUrl(submittedUrl = sourceUrl, sheetName = selectedSheet) {
    if (!submittedUrl) {
      setAnalysisMessageKind("error");
      setAnalysisMessage("Cole um link HTTPS para iniciar a análise.");
      return;
    }
    setIsAnalyzing(true);
    setAnalysisMessage("");
    try {
      const profileResponse = await fetch("/api/link-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_url: submittedUrl, sheet_name: sheetName }) });
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
    void profileSourceUrl();
  }

  function selectFoundFile(candidateUrl: string) {
    setSourceUrl(candidateUrl);
    void profileSourceUrl(candidateUrl);
  }

  async function saveDraft(includeAllSheets: boolean) {
    if (!sourceProfile) return;
    setIsSavingDraft(true);
    setAnalysisMessage("");
    try {
      const response = sourceFile
        ? await fetch("/api/import-draft", { method: "POST", body: (() => { const draftForm = new FormData(); draftForm.append("sourceFile", sourceFile); draftForm.append("title", sourceProfile.file_name); draftForm.append("include_all_sheets", String(includeAllSheets)); if (selectedSheet) draftForm.append("sheetName", selectedSheet); return draftForm; })() })
        : await fetch("/api/import-draft-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_url: sourceProfile.source_url, title: sourceProfile.file_name, sheet_name: selectedSheet, include_all_sheets: includeAllSheets }) });
      if (!response.ok) {
        setAnalysisMessageKind("error");
        setAnalysisMessage(await importErrorMessage(response, "Não conseguimos guardar essa fonte. Tente novamente."));
      }
      else {
        const payload = await response.json();
        setDraftImportId(payload.import_id);
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
    setIsDiscarding(true);
    try {
      const response = await fetch(`/api/imports/${draftImportId}/discard`, { method: "POST" });
      if (response.ok) {
        setDraftImportId(null);
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

  return <div className={styles.applicationShell}>
    <aside className={styles.sidebar}>
      <div className={styles.sidebarTop}>
        <div>
          <p className={styles.productName}>DECSYS</p>
        </div>
        <nav aria-label="Navegação principal">
          <a className={styles.activeNav} href="/"><FileUp size={20} strokeWidth={1.5} />Importações</a>
          <a href="/dados-revisados"><Database size={20} strokeWidth={1.5} />Dados revisados</a>
          <a href="/indicadores"><ListTree size={20} strokeWidth={1.5} />Indicadores</a>
          <a href="/iiu"><ChartNoAxesCombined size={20} strokeWidth={1.5} />Índice IIU</a>
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
    </main>
  </div>;
}
