import { ingestionSegment, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ importId: string }> }) {
  const { importId } = await context.params;
  return proxyToIngestion(`/imports/${ingestionSegment(importId)}/validation-issues`);
}
