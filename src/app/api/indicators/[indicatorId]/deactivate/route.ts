import { ingestionSegment, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ indicatorId: string }> }) {
  const { indicatorId } = await context.params;
  return proxyToIngestion(`/indicators/${ingestionSegment(indicatorId)}/deactivate`, { method: "POST" });
}
