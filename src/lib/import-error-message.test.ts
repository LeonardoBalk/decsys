import { describe, expect, it } from "vitest";
import { importErrorMessage } from "./import-error-message";

describe("importErrorMessage", () => {
  it("uses the FastAPI detail when present", async () => {
    const response = new Response(JSON.stringify({ detail: "Aba inexistente." }), { status: 422 });
    expect(await importErrorMessage(response, "fallback")).toBe("Aba inexistente.");
  });

  it("uses the proxy message when present", async () => {
    const response = new Response(JSON.stringify({ message: "Serviço fora do ar." }), { status: 503 });
    expect(await importErrorMessage(response, "fallback")).toBe("Serviço fora do ar.");
  });

  it("identifies fields rejected by FastAPI validation", async () => {
    const response = new Response(JSON.stringify({ detail: [{ loc: ["body", "unit"], msg: "Field required" }, { loc: ["body", "code"], msg: "Field required" }] }), { status: 422 });
    expect(await importErrorMessage(response, "fallback")).toBe("Confira estes campos: unidade, código interno.");
  });

  it("explains large files and server failures when the body is not JSON", async () => {
    expect(await importErrorMessage(new Response("too large", { status: 413 }), "fallback")).toMatch(/grande demais/);
    expect(await importErrorMessage(new Response("boom", { status: 500 }), "fallback")).toMatch(/não conseguiu concluir/);
    expect(await importErrorMessage(new Response("nope", { status: 404 }), "fallback")).toBe("fallback");
  });
});
