import { NextResponse } from "next/server";
import { ingestionSegment, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ importId: string; format: string }> }) {
  const { importId, format } = await context.params;
  if (format !== "csv" && format !== "xlsx") return NextResponse.json({ message: "Formato de exportação não suportado." }, { status: 400 });
  return proxyToIngestion(`/imports/${ingestionSegment(importId)}/export.${format}`, { binary: true, timeoutMs: 300_000 });
}
