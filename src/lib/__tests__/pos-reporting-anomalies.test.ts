import { describe, expect, it } from "vitest";

import {
  unusualPosBillIds,
} from "../pos-reporting-anomalies";

import {
  posReportingErrorMessage,
} from "../pos-reporting-errors";

const makeBills = (amounts: number[]) =>
  amounts.map((grand_total, index) => ({
    id: `bill-${index}`,
    grand_total,
  }));

describe("NEO POS operational anomaly detection", () => {
  it("flags the reported KES 234.84 million bill", () => {
    const bills = makeBills([
      7500,
      50500,
      18000,
      3600,
      14700,
      60000,
      300,
      309,
      103,
      2369,
      9012.5,
      1339,
      1699.5,
      1854,
      2472,
      2111.5,
      1050,
      3399,
      92700,
      1545,
      4635,
      412000,
      772.5,
      234840000,
      309000,
    ]);

    expect(
      unusualPosBillIds(bills).has("bill-23"),
    ).toBe(true);
  });

  it("does not flag ordinary small bills", () => {
    const flagged = unusualPosBillIds(
      makeBills([1500, 2000, 2500, 3000, 3500]),
    );

    expect(flagged.size).toBe(0);
  });

  it("requires at least five positive observations", () => {
    expect(
      unusualPosBillIds(
        makeBills([1000, 2000, 10000000]),
      ).size,
    ).toBe(0);
  });

  it("ignores invalid and non-positive observations", () => {
    expect(
      unusualPosBillIds(
        makeBills([
          -100,
          0,
          1000,
          1500,
          Number.NaN,
          Number.POSITIVE_INFINITY,
        ]),
      ).size,
    ).toBe(0);
  });

  it("does not mutate the underlying bills", () => {
    const bills = makeBills([
      1000,
      2000,
      3000,
      4000,
      5000000,
    ]);

    const before = JSON.stringify(bills);

    unusualPosBillIds(bills);

    expect(JSON.stringify(bills)).toBe(before);
  });
});

describe("POS reporting error handling", () => {
  it("identifies missing database RPCs", () => {
    expect(
      posReportingErrorMessage({ code: "PGRST202" }),
    ).toContain("SQL migration");
  });

  it("identifies reporting permission failures", () => {
    expect(
      posReportingErrorMessage({ code: "42501" }),
    ).toContain("access denied");
  });

  it("retains unexpected error information", () => {
    expect(
      posReportingErrorMessage({
        code: "XX000",
        message: "Unexpected database error",
      }),
    ).toContain("Unexpected database error");
  });
});
