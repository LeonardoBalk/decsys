// Captura telas para conferência visual: node tests/e2e/shot.mjs <baseUrl> <saida> [rota...]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const [baseUrl, outDir, ...routes] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport });
  for (const route of routes) {
    await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
    const name = `${label}-${route.replace(/[^a-z0-9]+/gi, "_") || "home"}.png`;
    await page.screenshot({ path: `${outDir}/${name}`, fullPage: true });
    console.log(name, await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth ? "OVERFLOW-X" : "ok"));
  }
  await page.close();
}
await browser.close();
