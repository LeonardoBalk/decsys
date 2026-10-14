import { ingestionSegment, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ importId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  const { importId } = await context.params;
  const force = new URL(request.url).searchParams.get("force") === "true";
  return proxyToIngestion(`/imports/${ingestionSegment(importId)}${force ? "?force=true" : ""}`, { method: "DELETE", timeoutMs: 600_000 });
}
