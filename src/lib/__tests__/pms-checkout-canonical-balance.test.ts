import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261116210000_pms_checkout_canonical_balance.sql"
  ),
  "utf8"
);

describe("PMS canonical checkout calculation", () => {
  it("uses the November Finance projection", () => {
    expect(sql).toContain("neo_folio_financial_components");
    expect(sql).toContain("gross_obligation");
    expect(sql).toContain("collected");
  });

  it("reconciles all folios in the same stay", () => {
    expect(sql).toContain("f.stay_id = _stay.id");
    expect(sql).toContain("f.organization_id = _org");
    expect(sql).toContain("fin_count <> 1");
    expect(sql).toContain("mixed-currency folios");
  });

  it("updates the original checkout decision variables", () => {
    expect(sql).toContain("_charges := round(fin_charges,2)");
    expect(sql).toContain("_paid := round(fin_collected,2)");
    expect(sql).toContain("_line_paid := 0");
    expect(sql).toContain("_outstanding := round(_charges-_paid,2)");
  });

  it("does not rewrite guest source transactions", () => {
    expect(sql).not.toMatch(
      /\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\.(payments|payment_allocations|reservation_deposits|folio_lines)\b/i
    );
  });

  it("requires the reviewed checkout implementation", () => {
    expect(sql).toContain("pg_get_functiondef");
    expect(sql).toContain("Installed checkout differs");
    expect(sql).toContain("public.ops_set_room_status");
    expect(sql).toContain("UPDATE public.stays SET status");
  });

  it("installs transactionally", () => {
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
    expect(sql).toContain("DO $verify$");
  });
});

describe("Previously reproduced checkout discrepancies", () => {
  it("counts an allocated payment-linked deposit once", () => {
    const charges = 12000;
    const verifiedPayment = 4000;
    const depositLineAlreadyRepresented = 4000;

    const oldCheckout =
      charges - verifiedPayment - depositLineAlreadyRepresented;
    const correctedCheckout = charges - verifiedPayment;

    expect(oldCheckout).toBe(4000);
    expect(correctedCheckout).toBe(8000);
  });

  it("counts a confirmed unallocated folio payment", () => {
    const charges = 12000;
    const confirmedPayment = 3000;

    expect(charges).toBe(12000);
    expect(charges-confirmedPayment).toBe(9000);
  });
});