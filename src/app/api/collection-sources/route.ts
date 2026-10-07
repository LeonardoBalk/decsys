import { proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function GET() {
  return proxyToIngestion("/collection-sources");
}
