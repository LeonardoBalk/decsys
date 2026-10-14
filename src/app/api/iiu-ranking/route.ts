import { proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return proxyToIngestion(`/iiu-ranking${new URL(request.url).search}`);
}
