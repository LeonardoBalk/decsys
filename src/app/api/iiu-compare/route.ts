import { proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return proxyToIngestion(`/iiu-compare${new URL(request.url).search}`);
}
