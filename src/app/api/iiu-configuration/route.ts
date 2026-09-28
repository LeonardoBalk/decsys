import { proxyToIngestion } from "@/lib/ingestion-proxy";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const cityProfile = new URL(request.url).searchParams.get("city_profile") ?? "medio";
  return proxyToIngestion(`/iiu-configuration?city_profile=${encodeURIComponent(cityProfile)}`);
}
