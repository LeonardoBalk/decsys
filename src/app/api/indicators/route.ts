import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const ingestionResponse = await fetch(`${process.env.INGESTION_API_URL ?? "http://127.0.0.1:8000"}/indicators`, { cache: "no-store" });
  return NextResponse.json(await ingestionResponse.json(), { status: ingestionResponse.status });
}
