import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestionSegment, proxyToIngestion } from "./ingestion-proxy";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("proxyToIngestion", () => {
  it("passes JSON responses and status through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Aba inexistente." }), { status: 422 })));
    const response = await proxyToIngestion("/profile");
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "Aba inexistente." });
  });

  it("explains when the ingestion service is offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const response = await proxyToIngestion("/profile");
    expect(response.status).toBe(503);
    expect((await response.json()).message).toMatch(/não está respondendo/);
  });

  it("explains timeouts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timeout", "TimeoutError")));
    const response = await proxyToIngestion("/profile");
    expect(response.status).toBe(504);
  });

  it("turns non-JSON errors into a readable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 })));
    const response = await proxyToIngestion("/profile");
    expect(response.status).toBe(500);
    expect((await response.json()).message).toMatch(/erro 500/);
  });

  it("streams binary exports with their headers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("a;b", { status: 200, headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=\"x.csv\"" } })));
    const response = await proxyToIngestion("/imports/x/export.csv", { binary: true });
    expect(response.headers.get("Content-Disposition")).toBe("attachment; filename=\"x.csv\"");
    expect(await response.text()).toBe("a;b");
  });

  it("encodes path segments", () => {
    expect(ingestionSegment("../indicators")).toBe("..%2Findicators");
  });
});
