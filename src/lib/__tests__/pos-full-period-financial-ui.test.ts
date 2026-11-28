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

const card = readFileSync(
  "src/components/pos/PosFullPeriodFinancialCard.tsx",
  "utf8",
);

describe("NEO full-period financial UI integration", () => {
  it("retains POS reporting authorization", () => {
    expect(report).toContain(
      '<PosGuard action="reports.view" path="/pos/reports">',
    );
  });

  it("uses the full-period PostgreSQL RPC", () => {
    expect(data).toContain(
      '"neo_pos_full_period_financial_evidence" as never',
    );
  });

  it("uses the selected reporting dates", () => {
    expect(report).toContain(
      "<PosFullPeriodFinancialCard from={from} to={to} />",
    );
  });

  it("reports finalized bills and collections separately", () => {
    expect(card).toContain("Finalized bill value");
    expect(card).toContain("Confirmed POS collections");
  });

  it("separates refunds and room charges", () => {
    expect(card).toContain("Processed refund evidence");
    expect(card).toContain("Room-charge payment evidence");
  });

  it("does not claim the financial summary is GL revenue", () => {
    expect(card).toContain(
      "Not a Finance general-ledger revenue statement.",
    );
  });

  it("labels the complete-period KPI as finalized bill value", () => {
    expect(report).toContain(
      'label: "Finalized bill value"',
    );

    expect(report).toContain(
      "usePosCompletePeriodOrders(",
    );

    expect(report).not.toContain(
      'usePosOrders("closed")',
    );
  });

  it("retains existing reporting and exports", () => {
    expect(report).toContain("ReportExportButton");
    expect(report).toContain("ReportExceptions");
    expect(report).toContain("ReportKpiGrid");
  });

  it("uses a read-only reporting query", () => {
    const hook = data.split(
      "export function usePosFullPeriodFinancialEvidence(",
    )[1]?.split(
      "export function usePosCollectionEvidence(",
    )[0];

    expect(hook).toBeDefined();
    expect(hook).toContain("supabase.rpc(");
    expect(hook).not.toContain(".insert(");
    expect(hook).not.toContain(".update(");
    expect(hook).not.toContain(".delete(");
  });
});
