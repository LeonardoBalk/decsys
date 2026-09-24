import { proxyToIngestion } from "@/lib/ingestion-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return proxyToIngestion("/keepalive", { headers: { Authorization: request.headers.get("authorization") ?? "" }, timeoutMs: 15_000 });
}
