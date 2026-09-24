import { NextResponse } from "next/server";
import { proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const submittedForm = await request.formData();
  const sourceFile = submittedForm.get("sourceFile");
  const uploadToken = submittedForm.get("uploadToken");
  const ingestionForm = new FormData();
  if (typeof uploadToken === "string" && uploadToken) ingestionForm.append("upload_token", uploadToken);
  else if (sourceFile instanceof File) ingestionForm.append("file", sourceFile, sourceFile.name);
  else return NextResponse.json({ message: "Envie um arquivo para criar o rascunho." }, { status: 400 });
  for (const fieldName of ["dataset_id", "title", "reference_year", "include_all_sheets"]) {
    const fieldValue = submittedForm.get(fieldName);
    if (typeof fieldValue === "string" && fieldValue) ingestionForm.append(fieldName, fieldValue);
  }
  const selectedSheet = submittedForm.get("sheetName");
  if (typeof selectedSheet === "string" && selectedSheet) ingestionForm.append("sheet_name", selectedSheet);
  return proxyToIngestion("/imports/draft", { method: "POST", body: ingestionForm, timeoutMs: 300_000 });
}
