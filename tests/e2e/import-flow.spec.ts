import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const spreadsheet = require("xlsx");
const fixtureDirectory = resolve(import.meta.dirname, "../../services/ingestion/tests/fixtures/import_formats");

test("uploads a multi-sheet workbook, switches sheets, and exports a preview", async ({ page }) => {
  await page.goto("/importar");
  await page.getByLabel("Arquivo").setInputFiles(resolve(fixtureDirectory, "multiple-domains.xlsx"));
  await page.getByRole("button", { name: "Analisar arquivo" }).click();

  await expect(page.getByRole("heading", { name: "Leitura inicial" })).toBeVisible();
  await expect(page.getByText("2 linhas reconhecidas")).toBeVisible();
  await expect(page.getByRole("button", { name: "Municipios · 2 registros" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("table tbody")).toContainText("3509502");

  await page.getByRole("button", { name: "Unidades da Federacao" }).click();
  await expect(page.getByRole("button", { name: "Unidades da Federacao · 2 registros" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("table tbody")).toContainText("645");

  await page.getByRole("button", { name: "Municipios" }).click();
  await expect(page.locator("table tbody")).toContainText("3509502");
  await page.getByRole("button", { name: "Continuar para destino" }).click();
  await expect(page.getByRole("heading", { name: "Destino" })).toBeVisible();

  const csvDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV da prévia (2 linhas)" }).click();
  const csvDownload = await csvDownloadPromise;
  expect(csvDownload.suggestedFilename()).toBe("multiple-domains-previa.csv");
  const csvContent = await readFile(await csvDownload.path(), "utf8");
  expect(csvContent).toContain("Campinas (SP)");
  expect(csvContent).toContain("55234.75");

  const xlsxDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "XLSX da prévia (2 linhas)" }).click();
  const xlsxDownload = await xlsxDownloadPromise;
  const xlsxContent = await readFile(await xlsxDownload.path());
  const workbook = spreadsheet.read(xlsxContent, { type: "buffer" });
  const previewRows = spreadsheet.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
  expect(previewRows).toContainEqual(expect.arrayContaining(["Campinas (SP)", 2023, 55234.75]));
});

test("uploads a Brazilian CSV and retains decimal-comma values", async ({ page }) => {
  await page.goto("/importar");
  await page.getByLabel("Arquivo").setInputFiles(resolve(fixtureDirectory, "brazil-decimal.csv"));
  await page.getByRole("button", { name: "Analisar arquivo" }).click();

  await expect(page.getByText("2 linhas reconhecidas")).toBeVisible();
  await expect(page.locator("table tbody")).toContainText("São Paulo");
  await expect(page.locator("table tbody")).toContainText("1234.5");
});

test("keeps empty, invalid, and duplicate records visible for review", async ({ page }) => {
  await page.goto("/importar");
  await page.getByLabel("Arquivo").setInputFiles(resolve(fixtureDirectory, "invalid-and-duplicate.csv"));
  await page.getByRole("button", { name: "Analisar arquivo" }).click();

  await expect(page.getByText("4 linhas reconhecidas")).toBeVisible();
  const previewRows = page.locator("table tbody tr");
  await expect(previewRows).toHaveCount(4);
  await expect(previewRows.filter({ hasText: "Campinas" })).toHaveCount(2);
  await expect(previewRows.nth(1).locator("td").nth(0)).toBeEmpty();
  await expect(previewRows.nth(2).locator("td").nth(2)).toBeEmpty();
});
