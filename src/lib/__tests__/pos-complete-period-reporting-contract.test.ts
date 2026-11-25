import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const data = readFileSync(
  "src/lib/pos-data.ts",
  "utf8",
);

const report = readFileSync(
  "src/routes/_shell.pos.reports.tsx",
  "utf8",
);

describe("NEO complete-period POS reporting", () => {
  const hook = data.split(
    "export function usePosCompletePeriodOrders(",
  )[1]?.split(
    "export function usePosOrders(",
  )[0];

  it("replaces the old 200-order report query", () => {
    expect(report).not.toContain(
      'usePosOrders("closed")',
    );

    expect(report).toContain(
      "usePosCompletePeriodOrders(",
    );
  });

  it("retrieves matching orders in server-side pages", () => {
    expect(hook).toBeDefined();
    expect(hook).toContain("const pageSize = 500");
    expect(hook).toContain(".range(");
    expect(hook).toContain("results.push(...batch)");
  });

  it("includes the previous comparison period", () => {
    expect(report).toContain(
      "previous?.from ?? from",
    );

    expect(report).toContain(
      "previous?.to ?? to",
    );
  });

  it("uses finalized closure timestamps", () => {
    expect(hook).toContain(
      '.gte("closed_at", startAt)',
    );

    expect(hook).toContain(
      '.lt("closed_at", endBefore)',
    );
  });

  it("preserves existing property and row access scope", () => {
    expect(hook).toContain("applyScope(");
    expect(hook).toContain('"pos_orders"');
  });

  it("rejects an incomplete oversized report", () => {
    expect(hook).toContain(
      "const maximumRows = 50000",
    );
    expect(hook).toContain(
      "the complete selected period",
    );
  });

  it("prevents incomplete CSV exports", () => {
    expect(report).toContain(
      "orders.isSuccess ? (",
    );

    expect(report).toContain("ReportExportButton");
  });

  it("keeps the reporting security guard", () => {
    expect(report).toContain(
      '<PosGuard action="reports.view" path="/pos/reports">',
    );
  });

  it("preserves exception and KPI reporting", () => {
    expect(report).toContain("ReportExceptions");
    expect(report).toContain("ReportKpiGrid");
    expect(report).toContain("collectExceptions");
  });


  it("requests exact server-side record counts", () => {
    expect(hook).toContain(
      '{ count: "exact" }',
    );
    expect(hook).toContain("expectedCount");
  });

  it("rejects incomplete response pages", () => {
    expect(hook).toContain(
      "received an incomplete page",
    );
    expect(hook).toContain(
      "results.length === expectedCount",
    );
  });

  it("paginates Source Bills beyond 100 records", () => {
    expect(report).toContain(
      "sourcePageSize = 100",
    );
    expect(report).toContain(
      "safeSourcePage * sourcePageSize",
    );
    expect(report).toContain(
      "setSourcePage((page) => page + 1)",
    );
  });

  it("resets pagination when reporting dates change", () => {
    expect(report).toContain("setSourcePage(0)");
    expect(report).toContain("[from, to]");
  });

  it("hides incomplete exception reporting", () => {
    expect(report).toMatch(
      /orders\.isSuccess && \(\s*<SectionCard\s+title="Exceptions"/,
    );
  });

  it("does not modify POS orders", () => {
    expect(hook).not.toContain(".insert(");
    expect(hook).not.toContain(".update(");
    expect(hook).not.toContain(".delete(");
  });
});
