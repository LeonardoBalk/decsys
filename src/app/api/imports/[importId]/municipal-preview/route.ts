import { jsonBody, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ importId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { importId } = await context.params;
  return proxyToIngestion(`/imports/${encodeURIComponent(importId)}/municipal-preview`, { ...(await jsonBody(request)), method: "POST" });
}
