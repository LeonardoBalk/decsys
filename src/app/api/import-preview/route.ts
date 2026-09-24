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
  else return NextResponse.json({ message: "Envie um arquivo CSV, XLSX, XLS ou JSON." }, { status: 400 });
  const selectedSheet = submittedForm.get("sheetName");
  if (typeof selectedSheet === "string" && selectedSheet) ingestionForm.append("sheet_name", selectedSheet);
  return proxyToIngestion("/profile", { method: "POST", body: ingestionForm, timeoutMs: 300_000 });
}
