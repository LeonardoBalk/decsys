import { jsonBody, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function GET() {
  return proxyToIngestion("/indicators");
}

export async function POST(request: Request) {
  return proxyToIngestion("/indicators", { ...(await jsonBody(request)), method: "POST" });
}
