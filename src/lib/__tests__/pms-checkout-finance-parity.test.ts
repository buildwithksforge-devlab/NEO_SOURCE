import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261116200000_pms_checkout_finance_parity_guard.sql"
  ),
  "utf8"
);

describe("PMS checkout reconciliation diagnostic", () => {
  it("does not replace or modify checkout", () => {
    expect(sql).toContain("neo_pms_checkout_finance_diagnostic");
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.pms_check_out/i
    );
    expect(sql).not.toMatch(
      /\b(UPDATE|DELETE FROM|INSERT INTO)\s+public\.(folios|payments|stays|rooms|reservation_deposits)\b/i
    );
  });

  it("compares both actual money representations", () => {
    expect(sql).toContain("neo_folio_financial_components");
    expect(sql).toContain("public.payment_allocations");
    expect(sql).toContain("public.folio_lines");
    expect(sql).toContain("'confirmed_allocations'");
    expect(sql).toContain("'payment_and_deposit_lines'");
    expect(sql).toContain("'difference'");
  });

  it("enforces organisation and branch access", () => {
    expect(sql).toContain("s.organization_id = v_org");
    expect(sql).toContain("f.organization_id=v_org");
    expect(sql).toContain("neo_branch_in_scope");
    expect(sql).toContain("checkout.perform");
  });

  it("is not callable by ordinary application users", () => {
    expect(sql).toMatch(/FROM PUBLIC,anon,authenticated;/);
    expect(sql).toMatch(/TO service_role;/);
  });

  it("does not silently accept an absent Finance balance", () => {
    expect(sql).toContain("Canonical Finance projection is incomplete");
    expect(sql).toContain("No financial folio exists for this stay");
  });
});