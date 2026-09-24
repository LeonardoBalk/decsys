import { describe, expect, it } from "vitest";
import { formatReferencePeriod, hasMonthlyPeriods } from "./reference-period";

describe("reference periods", () => {
  it("treats series that only use January as annual", () => {
    expect(hasMonthlyPeriods(["2023-01-01", "2024-01-01"])).toBe(false);
    expect(hasMonthlyPeriods(["2024-01-01", "2024-02-01"])).toBe(true);
  });

  it("shows only the year for annual values", () => {
    expect(formatReferencePeriod("2024-01-01", false)).toBe("2024");
  });

  it("shows month and year for monthly values", () => {
    expect(formatReferencePeriod("2024-07-01", true)).toMatch(/jul.*2024/);
  });
});
