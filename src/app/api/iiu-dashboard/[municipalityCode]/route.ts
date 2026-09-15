import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ municipalityCode: string }> }) {
  const { municipalityCode } = await context.params;
  const ingestionAddress = process.env.INGESTION_API_URL ?? "http://127.0.0.1:8000";
  const queryString = new URL(request.url).search;
  const ingestionResponse = await fetch(`${ingestionAddress}/iiu-dashboard/${municipalityCode}${queryString}`, { cache: "no-store" });
  return NextResponse.json(await ingestionResponse.json(), { status: ingestionResponse.status });
}
