import { describe, expect, it } from "vitest";
import { blankNameRows, confirmedMatches, currentChoice, groupMatches, isIbgeCode, matchesFilter, MunicipalityMatch, needsDecision, normalizedSearchText } from "./municipality-decisions";

const campinas = { ibge_code: "3509502", name: "Campinas", state: "SP" };
const bomJesusA = { ibge_code: "4302105", name: "Bom Jesus", state: "RS" };
const bomJesusB = { ibge_code: "4302303", name: "Bom Jesus", state: "RS" };

const matches: MunicipalityMatch[] = [
  { row_number: 1, original_name: "Campinas (SP)", status: "matched", suggestion: campinas, candidates: [] },
  { row_number: 2, original_name: "Bom Jesus (RS)", status: "ambiguous", suggestion: null, candidates: [bomJesusA, bomJesusB] },
  { row_number: 3, original_name: "Sampa", status: "unmatched", suggestion: null, candidates: [] },
  { row_number: 4, original_name: "Bom Jesus (RS)", status: "ambiguous", suggestion: null, candidates: [bomJesusA, bomJesusB] },
  { row_number: 5, original_name: "", status: "unmatched", suggestion: null, candidates: [] },
  { row_number: 6, original_name: "Bom Jesus (RS)", status: "ambiguous", suggestion: null, candidates: [bomJesusA, bomJesusB] },
  { row_number: 7, original_name: "Campinas (SP)", status: "matched", suggestion: campinas, candidates: [] },
];

describe("municipality decisions", () => {
  it("groups rows by name, pending names first, and leaves blank names out", () => {
    const groups = groupMatches(matches);
    expect(groups.map((group) => [group.originalName, group.rowNumbers])).toEqual([["Bom Jesus (RS)", [2, 4, 6]], ["Sampa", [3]], ["Campinas (SP)", [1, 7]]]);
    expect(blankNameRows(matches)).toBe(1);
  });

  it("keeps exact matches unless the reviewer changes them", () => {
    const groups = groupMatches(matches);
    expect(confirmedMatches(groups, {})).toEqual([
      { row_number: 1, ibge_code: "3509502", origin: "exact" },
      { row_number: 7, ibge_code: "3509502", origin: "exact" },
    ]);
  });

  it("applies one decision to every row with the same name, including corrections of exact matches", () => {
    const groups = groupMatches(matches);
    const confirmed = confirmedMatches(groups, {
      "Bom Jesus (RS)": { ibge_code: "4302303", label: "Bom Jesus (RS)", origin: "candidate" },
      Sampa: { ibge_code: "3550308", label: "São Paulo (SP)", origin: "manual" },
      "Campinas (SP)": { ibge_code: "3550308", label: "São Paulo (SP)", origin: "manual" },
    });
    expect(confirmed).toEqual([
      { row_number: 2, ibge_code: "4302303", origin: "candidate" },
      { row_number: 4, ibge_code: "4302303", origin: "candidate" },
      { row_number: 6, ibge_code: "4302303", origin: "candidate" },
      { row_number: 3, ibge_code: "3550308", origin: "manual" },
      { row_number: 1, ibge_code: "3550308", origin: "manual" },
      { row_number: 7, ibge_code: "3550308", origin: "manual" },
    ]);
  });

  it("lets the reviewer leave an exact match without code", () => {
    const groups = groupMatches(matches);
    const decisions = { "Campinas (SP)": { ibge_code: null, label: "", origin: "manual" as const } };
    expect(confirmedMatches(groups, decisions)).toEqual([]);
    expect(currentChoice(groups[2], decisions["Campinas (SP)"])).toBeNull();
  });

  it("filters names by decision state", () => {
    const groups = groupMatches(matches);
    const decisions = { Sampa: { ibge_code: "3550308", label: "São Paulo (SP)", origin: "manual" as const } };
    expect(groups.filter((group) => matchesFilter(group, decisions, "pending")).map((group) => group.originalName)).toEqual(["Bom Jesus (RS)"]);
    expect(groups.filter((group) => matchesFilter(group, decisions, "changed")).map((group) => group.originalName)).toEqual(["Sampa"]);
    expect(groups.filter((group) => matchesFilter(group, decisions, "exact")).map((group) => group.originalName)).toEqual(["Campinas (SP)"]);
    expect(needsDecision(groups[1], decisions)).toBe(false);
  });

  it("validates codes and searches without accents", () => {
    expect(isIbgeCode("3550308")).toBe(true);
    expect(isIbgeCode("35503a8")).toBe(false);
    expect(normalizedSearchText("  São Paulo ")).toBe("sao paulo");
  });
});
