import { ingestionSegment, jsonBody, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ indicatorId: string }> }) {
  const { indicatorId } = await context.params;
  return proxyToIngestion(`/indicators/${ingestionSegment(indicatorId)}`);
}

export async function PATCH(request: Request, context: { params: Promise<{ indicatorId: string }> }) {
  const { indicatorId } = await context.params;
  return proxyToIngestion(`/indicators/${ingestionSegment(indicatorId)}`, { ...(await jsonBody(request)), method: "PATCH" });
}
