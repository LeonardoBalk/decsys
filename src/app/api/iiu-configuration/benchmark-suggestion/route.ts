import { proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const indicatorCode = new URL(request.url).searchParams.get("indicator_code") ?? "";
  return proxyToIngestion(`/iiu-configuration/benchmark-suggestion?indicator_code=${encodeURIComponent(indicatorCode)}`);
}
