import { ingestionSegment, jsonBody, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ importId: string }> }) {
  const { importId } = await context.params;
  const background = new URL(request.url).searchParams.get("background") === "true" ? "?background=true" : "";
  return proxyToIngestion(`/imports/${ingestionSegment(importId)}/filter-rows${background}`, { ...(await jsonBody(request)), method: "POST", timeoutMs: 120_000 });
}
