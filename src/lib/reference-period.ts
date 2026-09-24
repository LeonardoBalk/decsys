export function hasMonthlyPeriods(referencePeriods: string[]) {
  return referencePeriods.some((referencePeriod) => referencePeriod.slice(5, 7) !== "01");
}

export function formatReferencePeriod(referencePeriod: string, isMonthly: boolean) {
  const [year, month] = referencePeriod.split("-");
  if (!isMonthly || !month) return year ?? referencePeriod;
  return new Date(`${year}-${month}-01T12:00:00`).toLocaleDateString("pt-BR", { month: "short", year: "numeric" });
}
