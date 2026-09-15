import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const ingestionAddress = process.env.INGESTION_API_URL ?? "http://127.0.0.1:8000";
  const queryString = new URL(request.url).search;
  const ingestionResponse = await fetch(`${ingestionAddress}/iiu-municipalities${queryString}`, { cache: "no-store" });
  return NextResponse.json(await ingestionResponse.json(), { status: ingestionResponse.status });
}
