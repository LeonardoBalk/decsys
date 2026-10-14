// Opções novas da aprovação (população, limites, filtro, progresso) com a API simulada.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const [baseUrl, shots] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
const indicators = [
  { id: "i1", code: "qvi03_leitos_hospitalares_por_mil_habitantes", name: "QVI03 — Leitos hospitalares por mil habitantes", unit: "leitos/1.000 hab.", dimension: "Qualidade de Vida", calculation_type: "ratio", calculation_multiplier: 1000, expected_frequency: "anual" },
  { id: "i2", code: "qvi02_cobertura_da_atencao_primaria_esf", name: "QVI02 — Cobertura da Atenção Primária/ESF", unit: "%", dimension: "Qualidade de Vida", calculation_type: "direct", expected_frequency: "anual" },
];
let jobPolls = 0;
let approvalBody = null;
await page.route("**/api/indicators", (route) => route.fulfill({ json: indicators }));
await page.route("**/api/imports/imp-1/validation-issues", (route) => route.fulfill({ json: [] }));
await page.route("**/api/imports/imp-1/approve-municipal-batch**", async (route) => { approvalBody = route.request().postDataJSON(); await route.fulfill({ status: 202, json: { job_id: "job-1", kind: "approve", status: "running", phase: "Iniciando", progress: 0 } }); });
await page.route("**/api/jobs/job-1", (route) => {
  jobPolls += 1;
  if (jobPolls < 3) return route.fulfill({ json: { job_id: "job-1", status: "running", phase: jobPolls === 1 ? "Lendo as linhas da importação" : "Gravando parte 2 de 7", progress: jobPolls === 1 ? 0.1 : 0.5, result: null, error: null } });
  return route.fulfill({ json: { job_id: "job-1", status: "done", phase: "Concluído", progress: 1, error: null, result: { import_id: "imp-1", status: "approved", approved_value_count: 5570, chunks: 7, missing_population_years: [2010], period_problem_count: 0, period_problems: [], municipality_problem_count: 0, municipality_problems: [], indicator_results: [{ indicator_id: "i1", indicator_code: "qvi03", indicator_name: "QVI03 — Leitos", approved_rows: 5570, value_problem_count: 12, value_problems: [] }] } } });
});
await page.goto(`${baseUrl}/approval-preview`, { waitUntil: "networkidle" });

// escolhe o indicador pela busca
await page.getByRole("combobox", { name: "Indicador" }).click();
await page.getByRole("combobox", { name: "Indicador" }).fill("leitos");
await page.getByRole("option", { name: /QVI03/ }).click();

// per capita: numerador + população
await page.locator("label", { hasText: /^Numerador/ }).locator("select").selectOption("leitos");
await page.locator("label", { hasText: /^Dividir por/ }).locator("select").selectOption("population");
assert.equal(await page.locator("label", { hasText: /^Denominador/ }).count(), 0, "com população não há coluna de denominador");
await page.getByText("Esta medida não tem prévia").waitFor();
await page.getByLabel("Limitar valor máximo (opcional)").fill("2000");
await page.getByLabel("Limitar valor mínimo (opcional)").fill("0");
await page.getByText("Filtrar linhas antes de gravar").click();
await page.screenshot({ path: `${shots}/approval-opcoes.png`, fullPage: true });

await page.getByRole("button", { name: "Adicionar filtro" }).click();
await page.getByLabel("Coluna", { exact: true }).selectOption("sexo");
assert.equal(await page.getByRole("button", { name: "Criar aba filtrada" }).isDisabled(), true, "filtro sem valor não habilita");
await page.getByLabel("Valor", { exact: true }).fill("Total");
assert.equal(await page.getByRole("button", { name: "Criar aba filtrada" }).isDisabled(), false);

await page.getByRole("button", { name: /Validar e gravar/ }).click();
await page.getByText("Lendo as linhas da importação").waitFor();
await page.screenshot({ path: `${shots}/approval-progresso.png` });
await page.getByText("Resultado da gravação").waitFor({ timeout: 15000 });
await page.getByText("Gravado em 7 partes").waitFor();
await page.getByText(/não publica a população.*2010/).waitFor();
const mapping = approvalBody.mappings[0];
assert.deepEqual([mapping.denominator_source, mapping.numerator_field, mapping.value_min, mapping.value_max, mapping.denominator_field], ["population", "leitos", 0, 2000, undefined]);
console.log("ok: população, limites, filtro, progresso e resumo em partes");
await browser.close();
