import { ingestionSegment, jsonBody, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ importId: string }> }) {
  const { importId } = await context.params;
  return proxyToIngestion(`/imports/${ingestionSegment(importId)}/expand-periods`, { ...(await jsonBody(request)), method: "POST", timeoutMs: 300000 });
}
