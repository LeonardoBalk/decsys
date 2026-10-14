import { jsonBody, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const background = new URL(request.url).searchParams.get("background") === "true" ? "?background=true" : "";
  return proxyToIngestion(`/iiu-configuration/benchmarks/auto${background}`, { ...(await jsonBody(request)), method: "POST" });
}
