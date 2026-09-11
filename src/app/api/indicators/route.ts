import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ingestionAddress = process.env.INGESTION_API_URL ?? "http://127.0.0.1:8000";

export async function GET() {
  const ingestionResponse = await fetch(`${ingestionAddress}/indicators`, { cache: "no-store" });
  return NextResponse.json(await ingestionResponse.json(), { status: ingestionResponse.status });
}

export async function POST(request: Request) {
  const ingestionResponse = await fetch(`${ingestionAddress}/indicators`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await request.json()), cache: "no-store" });
  return NextResponse.json(await ingestionResponse.json(), { status: ingestionResponse.status });
}
