import { formatReferencePeriod, hasMonthlyPeriods } from "./reference-period";

export type CoverageEntry = {
  indicator_code: string;
  municipalities: number;
  value_count: number;
  first_period: string | null;
  last_period: string | null;
};

export type Coverage = {
  municipalities: number;
  values: number;
  firstPeriod: string | null;
  lastPeriod: string | null;
};

export type CoverageByCode = Map<string, Coverage>;

const MATRIX_CODE = /^([a-z]{3}\d{2})_/i;

export function collectionCodeFor(indicatorCode: string): string {
  const matrixCode = MATRIX_CODE.exec(indicatorCode);
  return (matrixCode ? matrixCode[1] : indicatorCode).toUpperCase();
}

function earliest(left: string | null, right: string | null): string | null {
  if (!left || !right) return left ?? right;
  return left <= right ? left : right;
}

function latest(left: string | null, right: string | null): string | null {
  if (!left || !right) return left ?? right;
  return left >= right ? left : right;
}

export function coverageByCode(entries: CoverageEntry[]): CoverageByCode {
  const byCode: CoverageByCode = new Map();
  for (const entry of entries) {
    const code = collectionCodeFor(entry.indicator_code);
    const current = byCode.get(code);
    byCode.set(code, {
      municipalities: Math.max(current?.municipalities ?? 0, entry.municipalities),
      values: (current?.values ?? 0) + entry.value_count,
      firstPeriod: earliest(current?.firstPeriod ?? null, entry.first_period),
      lastPeriod: latest(current?.lastPeriod ?? null, entry.last_period),
    });
  }
  return byCode;
}

export function coverageOf(code: string, coverage: CoverageByCode): Coverage | undefined {
  return coverage.get(code.toUpperCase());
}

export function hasData(code: string, coverage: CoverageByCode): boolean {
  return (coverageOf(code, coverage)?.values ?? 0) > 0;
}

function formatCount(value: number): string {
  return value.toLocaleString("pt-BR");
}

export function coverageLabel(coverage: Coverage): string {
  if (coverage.municipalities > 0) return `Importado: ${formatCount(coverage.municipalities)} ${coverage.municipalities === 1 ? "município" : "municípios"}`;
  return `Importado: ${formatCount(coverage.values)} ${coverage.values === 1 ? "valor" : "valores"}`;
}

export function coveragePeriod(coverage: Coverage): string | null {
  const { firstPeriod, lastPeriod } = coverage;
  if (!firstPeriod || !lastPeriod) return null;
  const isMonthly = hasMonthlyPeriods([firstPeriod, lastPeriod]);
  const first = formatReferencePeriod(firstPeriod, isMonthly);
  const last = formatReferencePeriod(lastPeriod, isMonthly);
  return first === last ? first : `${first} a ${last}`;
}

export function coverageDetail(coverage: Coverage): string {
  const parts = [`${formatCount(coverage.values)} ${coverage.values === 1 ? "valor publicado" : "valores publicados"}`];
  const period = coveragePeriod(coverage);
  if (period) parts.push(`período ${period}`);
  return parts.join(" · ");
}

export function countWithoutData<T extends { code: string }>(items: T[], coverage: CoverageByCode): number {
  return items.filter((item) => !hasData(item.code, coverage)).length;
}
