import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const submittedForm = await request.formData();
  const sourceFile = submittedForm.get("sourceFile");
  if (!(sourceFile instanceof File)) return NextResponse.json({ message: "Envie um arquivo para criar o rascunho." }, { status: 400 });
  const ingestionForm = new FormData();
  ingestionForm.append("file", sourceFile, sourceFile.name);
  for (const fieldName of ["dataset_id", "title", "reference_year"]) {
    const fieldValue = submittedForm.get(fieldName);
    if (typeof fieldValue === "string" && fieldValue) ingestionForm.append(fieldName, fieldValue);
  }
  const ingestionResponse = await fetch(`${process.env.INGESTION_API_URL ?? "http://localhost:8000"}/imports/draft`, { method: "POST", body: ingestionForm, cache: "no-store" });
  return NextResponse.json(await ingestionResponse.json(), { status: ingestionResponse.status });
}
