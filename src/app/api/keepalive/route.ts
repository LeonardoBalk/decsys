import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const ingestionAddress = process.env.INGESTION_API_URL ?? "http://127.0.0.1:8000";

  try {
    const ingestionResponse = await fetch(`${ingestionAddress}/keepalive`, {
      headers: { Authorization: request.headers.get("authorization") ?? "" },
      cache: "no-store",
    });
    const responsePayload = await ingestionResponse.json();
    return NextResponse.json(responsePayload, { status: ingestionResponse.status });
  } catch {
    return NextResponse.json({ error: "O serviço de dados não respondeu. Tente novamente mais tarde." }, { status: 503 });
  }
}
