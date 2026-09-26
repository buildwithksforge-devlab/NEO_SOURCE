import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  collectExceptions,
  compare,
  comparisonLabel,
  periodDays,
  previousPeriod,
  reconcileTotals,
  toReportCsv,
  type ReportColumn,
} from "@/lib/reporting-standard";

type Row = { id: string; ref: string; total: number };

const COLUMNS: ReportColumn<Row>[] = [
  { key: "ref", header: "Bill", value: (r) => r.ref },
  { key: "total", header: "Total", value: (r) => r.total, total: true },
];

describe("reporting standard — comparison window", () => {
  it("counts an inclusive period in whole days", () => {
    expect(periodDays({ from: "2026-08-01", to: "2026-08-07" })).toBe(7);
    expect(periodDays({ from: "2026-08-01", to: "2026-08-01" })).toBe(1);
    expect(periodDays({ from: "2026-08-07", to: "2026-08-01" })).toBe(0);
  });

  it("compares against the identical-length window immediately before", () => {
    expect(previousPeriod({ from: "2026-08-08", to: "2026-08-14" })).toEqual({
      from: "2026-08-01",
      to: "2026-08-07",
    });
  });

  it("crosses a month boundary without drifting", () => {
    expect(previousPeriod({ from: "2026-03-01", to: "2026-03-03" })).toEqual({
      from: "2026-02-26",
      to: "2026-02-28",
    });
  });

  it("never fabricates a percentage against an empty previous period", () => {
    const c = compare(1200, 0);
    expect(c.percent).toBeNull();
    expect(comparisonLabel(c)).toBe("No comparable activity in the previous period");
    expect(comparisonLabel(compare(0, 0))).toBe("No activity in either period");
    expect(comparisonLabel(compare(110, 100))).toContain("+10.0%");
    expect(comparisonLabel(compare(90, 100))).toContain("−10.0%");
  });
});

describe("reporting standard — exceptions", () => {
  const rows: Row[] = [
    { id: "a", ref: "B-1", total: 0 },
    { id: "b", ref: "B-2", total: 500 },
  ];

  it("lists offending rows individually with their source record", () => {
    const found = collectExceptions(rows, [
      {
        id: "zero",
        severity: "high",
        when: (r) => r.total <= 0,
        title: (r) => `${r.ref} has no value`,
        detail: () => "Zero-value bill",
        recordId: (r) => r.id,
      },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.recordId).toBe("a");
    expect(found[0]!.severity).toBe("high");
  });

  it("orders high severity first", () => {
    const found = collectExceptions(rows, [
      { id: "low", severity: "low", when: () => true, title: () => "low", detail: () => "" },
      { id: "high", severity: "high", when: (r) => r.total === 0, title: () => "high", detail: () => "" },
    ]);
    expect(found[0]!.title).toBe("high");
  });
});

describe("reporting standard — export reconciliation", () => {
  const rows: Row[] = [
    { id: "a", ref: "B-1", total: 100.5 },
    { id: "b", ref: "B-2", total: 249.5 },
  ];

  it("emits a TOTAL row that equals the sum of the exported rows", () => {
    const csv = toReportCsv(rows, COLUMNS);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('"TOTAL","350"');
  });

  it("reconciles the export against the on-screen figure", () => {
    const [total] = reconcileTotals(rows, COLUMNS, { total: 350 });
    expect(total!.reconciled).toBe(true);
    expect(total!.difference).toBe(0);
  });

  it("flags a mismatch instead of silently exporting a different number", () => {
    const [total] = reconcileTotals(rows, COLUMNS, { total: 400 });
    expect(total!.reconciled).toBe(false);
    expect(total!.difference).toBe(-50);
  });
});

describe("reporting standard — adoption", () => {
  it("POS reports use the shared standard, not a private CSV writer", () => {
    const src = readFileSync("src/routes/_shell.pos.reports.tsx", "utf8");
    expect(src).toContain("ReportKpiGrid");
    expect(src).toContain("ReportExceptions");
    expect(src).toContain("ReportExportButton");
    expect(src).toContain("previousPeriod");
    // Drill-down to the source record.
    expect(src).toContain("/pos/orders/$id");
    expect(src).not.toContain("function toCsv");
  });
});
