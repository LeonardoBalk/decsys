import { ingestionSegment, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ municipalityCode: string }> }) {
  const { municipalityCode } = await context.params;
  return proxyToIngestion(`/iiu-dashboard/${ingestionSegment(municipalityCode)}${new URL(request.url).search}`);
}
