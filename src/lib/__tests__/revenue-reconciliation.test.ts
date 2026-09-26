import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const posting = readFileSync("src/lib/finance-posting.ts", "utf8");
const panel = readFileSync("src/components/finance/RevenueVariance.tsx", "utf8");
const manifest = readFileSync("src/lib/rpc-manifest.ts", "utf8");

describe("revenue reconciliation", () => {
  it("reads one canonical variance service rather than summing revenue in the client", () => {
    expect(posting).toContain("neo_revenue_reconciliation");
    expect(panel).toContain("useRevenueReconciliation");
    // The panel must not build its own revenue figure from operational tables.
    expect(panel).not.toMatch(/from\(["'](pos_orders|journal_entry_lines|folio_lines)["']\)/);
  });

  it("always explains a difference instead of showing two disagreeing numbers", () => {
    expect(panel).toContain("explanation");
    expect(panel).toMatch(/Operations show/);
  });

  it("carries the awaiting, blocked and failed breakdown that explains the gap", () => {
    for (const field of ["awaiting_amount", "blocked_amount", "failed_amount", "variance"]) {
      expect(posting).toContain(field);
    }
  });

  it("exposes the chart-of-accounts completion action needed before postings can succeed", () => {
    expect(posting).toContain("neo_finance_ensure_accounts");
    expect(readFileSync("src/routes/_shell.finance.posting.tsx", "utf8")).toContain(
      "Complete chart of accounts",
    );
  });

  it("registers both services for signed-in callers only", () => {
    expect(manifest).toContain('neo_revenue_reconciliation: "authenticated"');
    expect(manifest).toContain('neo_finance_ensure_accounts: "authenticated"');
  });

  it("surfaces the variance wherever revenue KPIs are read", () => {
    for (const route of [
      "src/routes/_shell.finance.index.tsx",
      "src/routes/_shell.analytics.index.tsx",
      "src/routes/_shell.finance.posting.tsx",
    ]) {
      expect(readFileSync(route, "utf8")).toContain("RevenueVariancePanel");
    }
  });
});
