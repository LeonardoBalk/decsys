import styles from "../../page.module.css";
import { SourceProfile } from "@/lib/types/importacao";

type PreviewExportProps = { sourceProfile: SourceProfile; importId: string | null };

function baseFileName(fileName: string) {
  return fileName.replace(/\.(csv|xlsx|xls|json|zip|gz)$/i, "") || "dados";
}

function downloadFile(fileContent: BlobPart, fileName: string, mimeType: string) {
  const objectUrl = URL.createObjectURL(new Blob([fileContent], { type: mimeType }));
  const downloadLink = document.createElement("a");
  downloadLink.href = objectUrl;
  downloadLink.download = fileName;
  document.body.append(downloadLink);
  downloadLink.click();
  downloadLink.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

function exportCsv(sourceProfile: SourceProfile) {
  const fields = sourceProfile.sample[0] ? Object.keys(sourceProfile.sample[0]) : [];
  const escapeValue = (cellValue: unknown) => `"${String(cellValue ?? "").replaceAll('"', '""')}"`;
  const csvContent = [fields.map(escapeValue).join(";"), ...sourceProfile.sample.map((record) => fields.map((field) => escapeValue(record[field])).join(";"))].join("\r\n");
  downloadFile(`﻿${csvContent}`, `${baseFileName(sourceProfile.file_name)}-previa.csv`, "text/csv;charset=utf-8");
}

async function exportXlsx(sourceProfile: SourceProfile) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(sourceProfile.sample);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Prévia");
  XLSX.writeFile(workbook, `${baseFileName(sourceProfile.file_name)}-previa.xlsx`);
}

export function PreviewExport({ sourceProfile, importId }: PreviewExportProps) {
  const sampleSize = sourceProfile.sample.length.toLocaleString("pt-BR");
  const isPreviewOnly = !importId;

  function downloadExport(format: "csv" | "xlsx") {
    if (importId) window.location.assign(`/api/imports/${encodeURIComponent(importId)}/export/${format}`);
    else if (format === "csv") exportCsv(sourceProfile);
    else void exportXlsx(sourceProfile);
  }

  return <section className={styles.exportPanel}>
    <div>
      <h2>{isPreviewOnly ? "Baixar a prévia" : "Baixar a base completa"}</h2>
      <p>{isPreviewOnly
        ? `Antes de importar, o download contém só as ${sampleSize} primeiras linhas da prévia, não os ${sourceProfile.rows.toLocaleString("pt-BR")} registros. Para baixar tudo, importe a tabela abaixo.`
        : "Baixe todas as linhas importadas, com cada aba identificada."}</p>
    </div>
    <div className={styles.exportActions}>
      <button className={isPreviewOnly ? undefined : styles.primaryButton} onClick={() => downloadExport("csv")} type="button">{isPreviewOnly ? `CSV da prévia (${sampleSize} linhas)` : "Baixar CSV"}</button>
      <button onClick={() => downloadExport("xlsx")} type="button">{isPreviewOnly ? `XLSX da prévia (${sampleSize} linhas)` : "Baixar XLSX"}</button>
    </div>
  </section>;
}
