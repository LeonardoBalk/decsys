import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ importId: string }> }) {
  const { importId } = await context.params;
  const ingestionResponse = await fetch(`${process.env.INGESTION_API_URL ?? "http://127.0.0.1:8000"}/imports/${importId}/discard`, { method: "POST", cache: "no-store" });
  return NextResponse.json(await ingestionResponse.json(), { status: ingestionResponse.status });
}
