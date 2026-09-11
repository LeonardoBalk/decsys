import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ importId: string; format: string }> }) {
  const { importId, format } = await context.params;
  if (format !== "csv" && format !== "xlsx") return NextResponse.json({ message: "Formato de exportação não suportado." }, { status: 400 });
  const ingestionResponse = await fetch(`${process.env.INGESTION_API_URL ?? "http://localhost:8000"}/imports/${importId}/export.${format}`, { cache: "no-store" });
  return new Response(await ingestionResponse.arrayBuffer(), { status: ingestionResponse.status, headers: { "Content-Type": ingestionResponse.headers.get("Content-Type") ?? "application/octet-stream", "Content-Disposition": ingestionResponse.headers.get("Content-Disposition") ?? `attachment; filename="importacao-${importId}.${format}"` } });
}
