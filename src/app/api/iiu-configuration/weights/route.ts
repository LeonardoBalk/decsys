import { jsonBody, proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  return proxyToIngestion("/iiu-configuration/weights", { ...(await jsonBody(request)), method: "PUT" });
}
