import { jsonBody, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  return proxyToIngestion("/iiu-configuration/benchmark", { ...(await jsonBody(request)), method: "PUT" });
}
