import { buildCsv } from "@/lib/csv";
import { formatReferencePeriod, hasMonthlyPeriods } from "@/lib/reference-period";
import type { IiuSeriesPoint, IiuTimeseries } from "@/lib/types/iiu-paineis";

export type NumericPoint = { period: string; label: string; value: number; source: string; importTitle: string };

export function numericPoints(points: IiuSeriesPoint[]): NumericPoint[] {
  const monthly = points.some((point) => point.period_granularity === "month") || (!points.some((point) => point.period_granularity) && hasMonthlyPeriods(points.map((point) => point.reference_period)));
  return points.flatMap((point) => {
    const value = point.value === null || point.value === "" ? Number.NaN : Number(point.value);
    return Number.isFinite(value) ? [{ period: point.reference_period, label: formatReferencePeriod(point.reference_period, monthly), value, source: point.source_name, importTitle: point.import_title }] : [];
  });
}

export type SeriesSummary = { first: NumericPoint; last: NumericPoint; min: NumericPoint; max: NumericPoint; change: number; changePercent: number | null };

export function summarizeSeries(points: NumericPoint[]): SeriesSummary | null {
  if (!points.length) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const min = points.reduce((best, point) => (point.value < best.value ? point : best));
  const max = points.reduce((best, point) => (point.value > best.value ? point : best));
  return { first, last, min, max, change: last.value - first.value, changePercent: first.value === 0 ? null : ((last.value - first.value) / Math.abs(first.value)) * 100 };
}

export type ChartGeometry = {
  path: string;
  dots: { x: number; y: number; point: NumericPoint }[];
  yTicks: { y: number; value: number }[];
  xTicks: { x: number; label: string }[];
};

export type ChartFrame = { width: number; height: number; left: number; right: number; top: number; bottom: number };

function niceStep(range: number, targetTicks: number) {
  const rough = range / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
}

export function chartGeometry(points: NumericPoint[], frame: ChartFrame): ChartGeometry {
  if (!points.length) return { path: "", dots: [], yTicks: [], xTicks: [] };
  const values = points.map((point) => point.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const spread = rawMax - rawMin || Math.abs(rawMax) || 1;
  const step = niceStep(spread, 4);
  const axisMin = rawMin === rawMax ? Math.floor((rawMin - spread / 2) / step) * step : Math.floor(rawMin / step) * step;
  const axisMax = rawMin === rawMax ? Math.ceil((rawMax + spread / 2) / step) * step : Math.ceil(rawMax / step) * step;
  const innerWidth = frame.width - frame.left - frame.right;
  const innerHeight = frame.height - frame.top - frame.bottom;
  const x = (index: number) => frame.left + (points.length === 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);
  const y = (value: number) => frame.top + innerHeight - ((value - axisMin) / (axisMax - axisMin)) * innerHeight;
  const dots = points.map((point, index) => ({ x: x(index), y: y(point.value), point }));
  const yTicks: ChartGeometry["yTicks"] = [];
  for (let tick = axisMin; tick <= axisMax + step / 2; tick += step) yTicks.push({ y: y(tick), value: Number(tick.toPrecision(12)) });
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const xTicks = dots.filter((_, index) => index % labelEvery === 0 || index === points.length - 1).filter((dot, index, list) => index === list.length - 1 || list[list.length - 1].x - dot.x > innerWidth / 12).map((dot) => ({ x: dot.x, label: dot.point.label }));
  return { path: dots.map((dot, index) => `${index ? "L" : "M"}${dot.x.toFixed(1)},${dot.y.toFixed(1)}`).join(" "), dots, yTicks, xTicks };
}

export function timeseriesToCsv(series: IiuTimeseries) {
  const header = ["Código IBGE", "Município", "UF", "Indicador", "Período", "Valor", "Unidade", "Fonte", "Importação"];
  return buildCsv(header, series.points.map((point) => [series.municipality_ibge_code, series.municipality_name, series.state, series.indicator?.name ?? "", point.reference_period, point.value === null || point.value === "" ? null : Number(point.value), point.unit, point.source_name, point.import_title]));
}

export function formatSeriesValue(value: number) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2 }).format(value);
}
