import { ingestionSegment, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ importId: string }> }) {
  const { importId } = await context.params;
  const sheetName = new URL(request.url).searchParams.get("sheet_name");
  const query = sheetName ? `?sheet_name=${encodeURIComponent(sheetName)}` : "";
  return proxyToIngestion(`/imports/${ingestionSegment(importId)}/sheets${query}`);
}
