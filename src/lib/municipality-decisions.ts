export type MunicipalitySuggestion = { ibge_code: string; name: string; state: string };
export type MunicipalityMatch = { row_number: number; original_name: string; status: "matched" | "unmatched" | "ambiguous"; suggestion: MunicipalitySuggestion | null; candidates: MunicipalitySuggestion[] };
export type MunicipalityDecision = { ibge_code: string | null; label: string; origin: "candidate" | "manual" };
export type NameGroup = { originalName: string; status: MunicipalityMatch["status"]; suggestion: MunicipalitySuggestion | null; candidates: MunicipalitySuggestion[]; rowNumbers: number[] };
export type ConfirmedMatch = { row_number: number; ibge_code: string; origin: "exact" | "candidate" | "manual" };
export type GroupFilter = "pending" | "all" | "exact" | "changed";

export function isIbgeCode(value: string) {
  return /^\d{7}$/.test(value.trim());
}

export function municipalityLabel(municipality: MunicipalitySuggestion) {
  return `${municipality.name} (${municipality.state})`;
}

export function groupMatches(matches: MunicipalityMatch[]): NameGroup[] {
  const groups = new Map<string, NameGroup>();
  for (const match of matches) {
    if (!match.original_name.trim()) continue;
    const existingGroup = groups.get(match.original_name);
    if (existingGroup) existingGroup.rowNumbers.push(match.row_number);
    else groups.set(match.original_name, { originalName: match.original_name, status: match.status, suggestion: match.suggestion, candidates: match.candidates, rowNumbers: [match.row_number] });
  }
  return [...groups.values()].sort((first, second) =>
    Number(first.status === "matched") - Number(second.status === "matched")
    || second.rowNumbers.length - first.rowNumbers.length
    || first.originalName.localeCompare(second.originalName, "pt-BR"));
}

export function currentChoice(group: NameGroup, decision: MunicipalityDecision | undefined): { ibge_code: string; label: string } | null {
  if (decision) return decision.ibge_code ? { ibge_code: decision.ibge_code, label: decision.label } : null;
  if (group.status === "matched" && group.suggestion) return { ibge_code: group.suggestion.ibge_code, label: municipalityLabel(group.suggestion) };
  return null;
}

export function needsDecision(group: NameGroup, decisions: Record<string, MunicipalityDecision>) {
  return group.status !== "matched" && !decisions[group.originalName];
}

export function matchesFilter(group: NameGroup, decisions: Record<string, MunicipalityDecision>, filter: GroupFilter) {
  if (filter === "pending") return needsDecision(group, decisions);
  if (filter === "exact") return group.status === "matched" && !decisions[group.originalName];
  if (filter === "changed") return Boolean(decisions[group.originalName]);
  return true;
}

export function confirmedMatches(groups: NameGroup[], decisions: Record<string, MunicipalityDecision>): ConfirmedMatch[] {
  return groups.flatMap((group) => {
    const decision = decisions[group.originalName];
    const choice = currentChoice(group, decision);
    if (!choice || !isIbgeCode(choice.ibge_code)) return [];
    const origin: ConfirmedMatch["origin"] = !decision || (group.status === "matched" && group.suggestion?.ibge_code === choice.ibge_code) ? "exact" : decision.origin;
    return group.rowNumbers.map((rowNumber) => ({ row_number: rowNumber, ibge_code: choice.ibge_code, origin }));
  });
}

export function blankNameRows(matches: MunicipalityMatch[]) {
  return matches.filter((match) => !match.original_name.trim()).length;
}

export function normalizedSearchText(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}
