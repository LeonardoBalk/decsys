// Fluxo de adicionar/editar/restaurar fonte em /coleta com a API simulada: node tests/e2e/coleta-fontes.mjs <baseUrl> [pastaDeCapturas]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const [baseUrl, shots = "shots"] = process.argv.slice(2);
mkdirSync(shots, { recursive: true });
const store = new Map();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("dialog", (dialog) => void dialog.accept());
await page.route("**/api/collection-sources**", async (route) => {
  const request = route.request();
  const code = decodeURIComponent(new URL(request.url()).pathname.split("/").pop());
  if (request.method() === "GET") return route.fulfill({ json: [...store.values()] });
  if (request.method() === "PUT") {
    const body = request.postDataJSON();
    const saved = { code, ...body, officialLink: body.officialLink || "", importUrl: body.importUrl || null, manualUrl: body.manualUrl || null, notes: body.notes || null, verifiedOn: "2026-10-08" };
    store.set(code, saved);
    return route.fulfill({ json: saved });
  }
  store.delete(code);
  return route.fulfill({ json: { code, status: "deleted" } });
});

await page.goto(`${baseUrl}/coleta`, { waitUntil: "networkidle" });
const before = Number((await page.locator("p", { hasText: "indicadores em" }).first().innerText()).match(/^(\d+)/)[1]);

await page.getByRole("button", { name: "Adicionar fonte" }).click();
await page.getByLabel("Sigla").fill("sau01");
await page.getByLabel("Dimensão").fill("Saúde");
await page.getByLabel("Nome do indicador").fill("Leitos de UTI por mil habitantes");
await page.getByLabel("Fonte", { exact: true }).fill("DATASUS — CNES");
await page.getByLabel("Link para importar").fill("https://example.gov.br/leitos.csv");
await page.getByLabel("Passo a passo").fill("Abra o CSV e filtre o município.");
await page.screenshot({ path: `${shots}/coleta-form.png` });
await page.getByRole("button", { name: "Salvar fonte" }).click();
await page.getByText("SAU01 salva.").waitFor();
const after = Number((await page.locator("p", { hasText: "indicadores em" }).first().innerText()).match(/^(\d+)/)[1]);
assert.equal(after, before + 1, "o total deveria subir em 1");
await page.getByRole("heading", { name: "Saúde" }).waitFor();

await page.locator("summary", { hasText: "SAU01" }).click();
await page.locator("details[open]").getByRole("button", { name: "Editar" }).click();
assert.equal(await page.getByLabel("Sigla").isDisabled(), true, "a sigla não pode mudar na edição");
await page.getByLabel("Nome do indicador").fill("Leitos de UTI (editado)");
await page.getByRole("button", { name: "Salvar fonte" }).click();
await page.getByText("Leitos de UTI (editado)").waitFor();

await page.locator("details[open]").getByRole("button", { name: "Excluir" }).click();
await page.getByText("SAU01 excluída.").waitFor();
assert.equal(await page.getByText("Leitos de UTI (editado)").count(), 0);

// editar um indicador da matriz cria uma versão "Editada" e dá para restaurar
await page.locator("summary", { hasText: "ECO01" }).click();
await page.locator("details[open]").getByRole("button", { name: "Editar" }).click();
await page.getByLabel("Passo a passo").fill("Passo ajustado pela pessoa.");
await page.getByRole("button", { name: "Salvar fonte" }).click();
await page.getByText("ECO01 salva.").waitFor();
assert.ok(await page.getByText("Editada").count() >= 1, "deveria marcar como Editada");
await page.locator("details[open]").getByRole("button", { name: "Restaurar original" }).click();
await page.getByText("ECO01 voltou à versão original.").waitFor();

console.log("ok: adicionar, editar, excluir e restaurar funcionam");
await browser.close();
