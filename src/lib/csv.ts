export type CsvCell = string | number | null | undefined;

const formulaTriggers = /^[=+\-@\t\r]/;
function csvText(text: string) {
  const safeText = formulaTriggers.test(text) ? `'${text}` : text;
  return /[";\r\n]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText;
}
export function csvCell(cell: CsvCell) {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell).replace(".", ",") : "";
  return csvText(cell);
}

export function buildCsv(header: string[], rows: CsvCell[][]) {
  return `﻿${[header, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n")}\r\n`;
}

export function downloadCsv(fileName: string, csv: string) {
  const objectUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

export function csvFileName(prefix: string, ...parts: (string | null | undefined)[]) {
  const slug = [prefix, ...parts].filter(Boolean).join("-").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return `${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
}
