import economia from "@/data/coleta/economia.json";
import pessoas from "@/data/coleta/pessoas.json";
import governanca from "@/data/coleta/governanca.json";
import mobilidade from "@/data/coleta/mobilidade.json";
import ambiente from "@/data/coleta/ambiente.json";
import qualidadeDeVida from "@/data/coleta/qualidade-de-vida.json";
import infraestruturaDigital from "@/data/coleta/infraestrutura-digital.json";

export type CollectionAccess = "link" | "manual" | "local";

export type CollectionItem = {
  code: string;
  dimension: string;
  factor: string;
  name: string;
  definition: string;
  unit: string;
  source: string;
  officialLink: string;
  access: CollectionAccess;
  importUrl?: string;
  manualUrl?: string;
  steps: string;
  needs: string[];
  notes?: string;
  verifiedOn: string;
};

export const ACCESS_LABELS: Record<CollectionAccess, string> = {
  link: "Importar por link",
  manual: "Baixar manualmente",
  local: "Levantamento local"
};

export const collectionItems: CollectionItem[] = ([economia, pessoas, governanca, mobilidade, ambiente, qualidadeDeVida, infraestruturaDigital] as unknown as CollectionItem[][]).flat();

export function collectionDimensions(items: CollectionItem[] = collectionItems): string[] {
  return [...new Set(items.map((item) => item.dimension))];
}

export function countByAccess(items: CollectionItem[] = collectionItems): Record<CollectionAccess, number> {
  const totals: Record<CollectionAccess, number> = { link: 0, manual: 0, local: 0 };
  for (const item of items) totals[item.access] += 1;
  return totals;
}

export type CollectionOrigin = "base" | "custom" | "edited";
export type CollectionEntry = CollectionItem & { origin: CollectionOrigin };

/** Une o catálogo base com as fontes salvas: a mesma sigla substitui a original, siglas novas entram no fim da dimensão. */
export function mergeCollectionItems(base: CollectionItem[], saved: CollectionItem[]): CollectionEntry[] {
  const savedByCode = new Map(saved.map((item) => [item.code, item]));
  const baseCodes = new Set(base.map((item) => item.code));
  const merged: CollectionEntry[] = base.map((item) => {
    const override = savedByCode.get(item.code);
    return override ? { ...override, origin: "edited" } : { ...item, origin: "base" };
  });
  for (const item of saved) if (!baseCodes.has(item.code)) merged.push({ ...item, origin: "custom" });
  const dimensionOrder = collectionDimensions(merged);
  return merged.sort((left, right) => dimensionOrder.indexOf(left.dimension) - dimensionOrder.indexOf(right.dimension));
}

export type CollectionDraft = {
  code: string;
  dimension: string;
  factor: string;
  name: string;
  definition: string;
  unit: string;
  source: string;
  officialLink: string;
  access: CollectionAccess;
  importUrl: string;
  manualUrl: string;
  steps: string;
  needs: string;
  notes: string;
};

export const emptyCollectionDraft: CollectionDraft = { code: "", dimension: "", factor: "", name: "", definition: "", unit: "", source: "", officialLink: "", access: "link", importUrl: "", manualUrl: "", steps: "", needs: "", notes: "" };

export function draftFromItem(item: CollectionItem): CollectionDraft {
  return { code: item.code, dimension: item.dimension, factor: item.factor, name: item.name, definition: item.definition, unit: item.unit, source: item.source, officialLink: item.officialLink ?? "", access: item.access, importUrl: item.importUrl ?? "", manualUrl: item.manualUrl ?? "", steps: item.steps, needs: item.needs.join("; "), notes: item.notes ?? "" };
}

export function payloadFromDraft(draft: CollectionDraft) {
  const { code: _code, needs, ...fields } = draft;
  return { ...fields, needs: needs.split(/[;\n]/).map((need) => need.trim()).filter(Boolean) };
}

export function importHref(importUrl: string): string {
  return `/importar?link=${encodeURIComponent(importUrl)}`;
}

export function isHttpsUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
