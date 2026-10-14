import { ingestionSegment, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ municipalityCode: string }> }) {
  const { municipalityCode } = await context.params;
  return proxyToIngestion(`/iiu-municipality-profile/${ingestionSegment(municipalityCode)}`);
}
