import { jsonBody, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return proxyToIngestion("/imports/draft-link", { ...(await jsonBody(request)), method: "POST", timeoutMs: 300_000 });
}
