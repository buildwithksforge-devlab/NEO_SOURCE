import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260923103000_canonical_payment_journal_resolution.sql",
  ),
  "utf8",
);

const paymentsPage = readFileSync(
  join(process.cwd(), "src/routes/_shell.finance.payments.tsx"),
  "utf8",
);

describe("canonical payment-to-journal resolution", () => {
  it("roots the lifecycle in the cross-module payment attempt register", () => {
    expect(migration).toContain("FROM public.payment_attempts a");
    expect(migration).toContain("a.payment_table = 'payments'");
    expect(migration).toContain("a.payment_table = 'pos_payments'");
  });

  it("recognises a posted POS journal linked to either the tender or its order", () => {
    expect(migration).toContain("j.source_document_id = _payment");
    expect(migration).toContain("j.source_document_id = _source_record");
    expect(migration).toContain("lower(coalesce(j.source_module, '')) IN ('pos', 'restaurant')");
  });

  it("derives register state from posted-journal proof without rewriting transactions", () => {
    expect(migration).toContain("WHEN proof.journal_id IS NOT NULL");
    expect(migration).toContain("THEN 'posted'");
    expect(migration).not.toContain("UPDATE public.pos_payments");
    expect(migration).not.toContain("UPDATE public.journal_entries");
  });

  it("does not silently show a legacy stage while the lifecycle failed or is loading", () => {
    expect(paymentsPage).toContain("register.isLoading || lifecycle.isLoading");
    expect(paymentsPage).toContain("register.error ?? lifecycle.error");
  });
});
