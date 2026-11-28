import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const data = readFileSync("src/lib/pos-data.ts", "utf8");

const report = readFileSync(
  "src/routes/_shell.pos.reports.tsx",
  "utf8",
);

const card = readFileSync(
  "src/components/pos/PosFinanceReconciliationCard.tsx",
  "utf8",
);

describe("Finance reconciliation UI integration", () => {
  it("uses the Finance reconciliation RPC", () => {
    expect(data).toContain(
      "neo_pos_finance_room_transfer_register",
    );
  });

  it("passes reporting dates and property scope", () => {
    expect(data).toContain("_from: from");
    expect(data).toContain("_to: to");
    expect(data).toContain("_branch: branchId ?? null");
  });

  it("retrieves paginated evidence", () => {
    expect(data).toContain("const pageSize = 200");
    expect(data).toContain('.range(');
  });

  it("checks complete result counts", () => {
    expect(data).toContain("expectedCount");
    expect(data).toContain('{ count: "exact" }');
  });

  it("rejects incomplete results", () => {
    expect(data).toContain("incomplete page");
  });

  it("rejects duplicate order records", () => {
    expect(data).toContain("Duplicate reconciliation records");
  });

  it("connects the card to POS Reports", () => {
    expect(report).toContain(
      "<PosFinanceReconciliationCard from={from} to={to} />",
    );
  });

  it("retains the original financial report", () => {
    expect(report).toContain("PosFullPeriodFinancialCard");
  });

  it("retains cashier and employee reporting", () => {
    expect(report).toContain("PosCollectionEvidenceCard");
    expect(report).toContain("TeamPosPerformanceCard");
  });

  it("separates matches from exceptions", () => {
    expect(card).toContain('"structurally-matched"');
    expect(card).toContain("Requires investigation");
  });

  it("does not classify inaccessible evidence as missing", () => {
    expect(card).toContain("query.isError");
    expect(card).toContain(
      "Unavailable evidence must not be classified",
    );
  });

  it("identifies the register's financial limitations", () => {
    expect(card).toContain(
      "does not yet reconcile every",
    );
    expect(card).toContain(
      "must not be counted as separate revenue",
    );
  });
});
