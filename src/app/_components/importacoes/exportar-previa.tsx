import * as XLSX from "xlsx";
import styles from "../../page.module.css";
import { SourceProfile } from "@/lib/types/importacao";

type PreviewExportProps = { sourceProfile: SourceProfile; importId: string | null };

function downloadFile(fileContent: BlobPart, fileName: string, mimeType: string) {
  const objectUrl = URL.createObjectURL(new Blob([fileContent], { type: mimeType }));
  const downloadLink = document.createElement("a");
  downloadLink.href = objectUrl;
  downloadLink.download = fileName;
  downloadLink.click();
  URL.revokeObjectURL(objectUrl);
}

function exportCsv(sourceProfile: SourceProfile) {
  const fields = sourceProfile.sample[0] ? Object.keys(sourceProfile.sample[0]) : [];
  const escapeValue = (cellValue: unknown) => `"${String(cellValue ?? "").replaceAll('"', '""')}"`;
  const csvContent = [fields.map(escapeValue).join(";"), ...sourceProfile.sample.map((record) => fields.map((field) => escapeValue(record[field])).join(";"))].join("\r\n");
  downloadFile(`﻿${csvContent}`, `${sourceProfile.file_name}.csv`, "text/csv;charset=utf-8");
}

function exportXlsx(sourceProfile: SourceProfile) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(sourceProfile.sample);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Dados");
  XLSX.writeFile(workbook, `${sourceProfile.file_name}.xlsx`);
}

export function PreviewExport({ sourceProfile, importId }: PreviewExportProps) {
  function downloadExport(format: "csv" | "xlsx") {
    if (importId) window.location.assign(`/api/imports/${importId}/export/${format}`);
    else if (format === "csv") exportCsv(sourceProfile);
    else exportXlsx(sourceProfile);
  }
  return <section className={styles.exportPanel}>
    <div><h2>Salvar uma cópia tratada</h2><p>{importId ? "Baixe a base completa ou mantenha o rascunho encaminhado para revisão." : "Baixe a prévia para revisar fora do sistema."}</p></div>
    <div className={styles.exportActions}><button className={styles.primaryButton} onClick={() => downloadExport("csv")} type="button">Baixar CSV</button><button onClick={() => downloadExport("xlsx")} type="button">Baixar XLSX</button></div>
  </section>;
}
