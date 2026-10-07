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
