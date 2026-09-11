import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const submittedForm = await request.formData();
  const sourceFile = submittedForm.get("sourceFile");

  if (!(sourceFile instanceof File)) {
    return NextResponse.json({ message: "Envie um arquivo CSV, XLSX ou JSON." }, { status: 400 });
  }

  const ingestionAddress = process.env.INGESTION_API_URL ?? "http://127.0.0.1:8000";
  const ingestionForm = new FormData();
  ingestionForm.append("file", sourceFile, sourceFile.name);
  const selectedSheet = submittedForm.get("sheetName");
  if (typeof selectedSheet === "string" && selectedSheet) ingestionForm.append("sheet_name", selectedSheet);
  const ingestionResponse = await fetch(`${ingestionAddress}/profile`, {
    method: "POST",
    body: ingestionForm,
    cache: "no-store"
  });

  const ingestionPayload = await ingestionResponse.json();
  return NextResponse.json(ingestionPayload, { status: ingestionResponse.status });
}
