import { NextResponse } from "next/server";

const ingestionAddress = process.env.INGESTION_API_URL ?? "http://127.0.0.1:8000";
const defaultTimeoutMs = 120_000;

type ProxyOptions = {
  method?: "GET" | "POST" | "PATCH";
  body?: BodyInit;
  headers?: HeadersInit;
  timeoutMs?: number;
  binary?: boolean;
};

export function ingestionSegment(value: string) {
  return encodeURIComponent(value);
}

export async function jsonBody(request: Request): Promise<ProxyOptions> {
  return { body: await request.text(), headers: { "Content-Type": "application/json" } };
}

export async function proxyToIngestion(path: string, options: ProxyOptions = {}) {
  let ingestionResponse: Response;
  try {
    ingestionResponse = await fetch(`${ingestionAddress}${path}`, {
      method: options.method ?? "GET",
      body: options.body,
      headers: options.headers,
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs),
    });
  } catch (requestError) {
    const timedOut = requestError instanceof DOMException && requestError.name === "TimeoutError";
    return NextResponse.json(
      { message: timedOut
        ? "O serviço de tratamento demorou demais para responder. Tente novamente; se o arquivo for muito grande, divida-o em partes menores."
        : "O serviço de tratamento não está respondendo. Confira se ele foi iniciado (iniciar-tratamento.ps1) e tente novamente." },
      { status: timedOut ? 504 : 503 },
    );
  }

  if (options.binary && ingestionResponse.ok) {
    return new Response(ingestionResponse.body, {
      status: ingestionResponse.status,
      headers: {
        "Content-Type": ingestionResponse.headers.get("Content-Type") ?? "application/octet-stream",
        "Content-Disposition": ingestionResponse.headers.get("Content-Disposition") ?? "attachment",
      },
    });
  }

  const responseText = await ingestionResponse.text();
  try {
    return NextResponse.json(JSON.parse(responseText), { status: ingestionResponse.status });
  } catch {
    return NextResponse.json(
      { message: ingestionResponse.ok
        ? "O serviço de tratamento respondeu em um formato inesperado. Tente novamente."
        : `O serviço de tratamento falhou (erro ${ingestionResponse.status}). Tente novamente em alguns instantes.` },
      { status: ingestionResponse.ok ? 502 : ingestionResponse.status },
    );
  }
}
