import { jsonBody, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ importId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { importId } = await context.params;
  const background = new URL(request.url).searchParams.get("background") === "true" ? "?background=true" : "";
  return proxyToIngestion(`/imports/${encodeURIComponent(importId)}/approve-municipal-batch${background}`, { ...(await jsonBody(request)), method: "POST", timeoutMs: 600_000 });
}
