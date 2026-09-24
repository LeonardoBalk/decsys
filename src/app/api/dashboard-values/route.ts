import { proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return proxyToIngestion(`/dashboard-values${new URL(request.url).search}`);
}
