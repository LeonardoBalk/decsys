import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ importId: string }> }) {
  const { importId } = await context.params;
  const ingestionResponse = await fetch(`${process.env.INGESTION_API_URL ?? "http://127.0.0.1:8000"}/imports/${importId}/validation-issues`, { cache: "no-store" });
  return NextResponse.json(await ingestionResponse.json(), { status: ingestionResponse.status });
}
