import { ingestionSegment, jsonBody, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function PUT(request: Request, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params;
  return proxyToIngestion(`/collection-sources/${ingestionSegment(code)}`, { ...(await jsonBody(request)), method: "PUT" });
}

export async function DELETE(_: Request, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params;
  return proxyToIngestion(`/collection-sources/${ingestionSegment(code)}`, { method: "DELETE" });
}
