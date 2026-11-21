import { describe, expect, it } from "vitest";
import { formatReportFact } from "@/lib/report-fact-format";

describe("financial report fact presentation", () => {
  it.each([true, false, {}, [], "NaN", Infinity, " "])("does not turn invalid facts into money: %j", (value) => {
    expect(formatReportFact(value, "money", "KES")).toMatch(/Invalid data/);
  });
  it("keeps missing data distinct from a real zero", () => {
    expect(formatReportFact(null, "money", "KES")).toBe("Awaiting data");
    expect(formatReportFact(0, "money", "KES")).toBe("KES 0.00");
  });
  it("retains negative adjustments and configured currency", () => {
    expect(formatReportFact("-1234.50", "money", "USD")).toBe("USD -1,234.50");
    expect(formatReportFact(100, "money", "")).toBe("Currency not verified");
  });
  it("retains percentage units supplied by the report contract", () => {
    expect(formatReportFact(87.25, "percent", "KES")).toBe("87.3%");
  });
});
