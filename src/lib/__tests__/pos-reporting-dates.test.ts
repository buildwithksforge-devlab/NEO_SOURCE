import { describe, expect, it } from "vitest";

import {
  isValidPosReportingDate,
} from "../pos-reporting-dates";

describe("NEO POS reporting date validation", () => {
  it("accepts valid Kenyan reporting dates", () => {
    expect(isValidPosReportingDate("2026-11-25")).toBe(true);
    expect(isValidPosReportingDate("2026-11-24")).toBe(true);
  });

  it("accepts a valid leap day", () => {
    expect(isValidPosReportingDate("2024-02-29")).toBe(true);
  });

  it("rejects impossible calendar dates", () => {
    expect(isValidPosReportingDate("2026-02-30")).toBe(false);
    expect(isValidPosReportingDate("2026-11-31")).toBe(false);
    expect(isValidPosReportingDate("2025-02-29")).toBe(false);
  });

  it("rejects incorrect date formats", () => {
    expect(isValidPosReportingDate("25/11/2026")).toBe(false);
    expect(isValidPosReportingDate("2026-1-5")).toBe(false);
    expect(isValidPosReportingDate("2026-11-25T00:00:00Z")).toBe(false);
  });

  it("rejects invalid month and day values", () => {
    expect(isValidPosReportingDate("2026-00-01")).toBe(false);
    expect(isValidPosReportingDate("2026-13-01")).toBe(false);
    expect(isValidPosReportingDate("2026-11-00")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidPosReportingDate(null)).toBe(false);
    expect(isValidPosReportingDate(undefined)).toBe(false);
    expect(isValidPosReportingDate(20261125)).toBe(false);
  });

  it("rejects an invalid year", () => {
    expect(isValidPosReportingDate("0000-01-01")).toBe(false);
  });
});
