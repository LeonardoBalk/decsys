import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ importId: string }> }) {
  const { importId } = await context.params;
  const ingestionAddress = process.env.INGESTION_API_URL ?? "http://127.0.0.1:8000";
  const ingestionResponse = await fetch(`${ingestionAddress}/imports/${importId}/normalize-municipal-wide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await request.json()), cache: "no-store" });
  return NextResponse.json(await ingestionResponse.json(), { status: ingestionResponse.status });
}
