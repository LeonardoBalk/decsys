import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const sourceRequest = await request.json();
  const ingestionAddress = process.env.INGESTION_API_URL ?? "http://127.0.0.1:8000";
  const ingestionResponse = await fetch(`${ingestionAddress}/profile-link`, { method: "POST", body: JSON.stringify(sourceRequest), headers: { "Content-Type": "application/json" }, cache: "no-store" });
  const ingestionPayload = await ingestionResponse.json();
  return NextResponse.json(ingestionPayload, { status: ingestionResponse.status });
}
