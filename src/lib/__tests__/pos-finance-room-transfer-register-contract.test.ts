import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20261124160000_pos_finance_room_transfer_register.sql",
  "utf8",
);

describe("NEO Finance room-transfer SQL contract", () => {
  it("creates the reconciliation function", () => {
    expect(sql).toContain(
      "neo_pos_finance_room_transfer_register",
    );
  });

  it("preserves the caller's database security context", () => {
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).not.toContain("SECURITY DEFINER");
  });

  it("requires authentication and reporting permission", () => {
    expect(sql).toContain(
      "auth.uid() IS NOT NULL",
    );
    expect(sql).toContain(
      "public.has_permission(",
    );
  });

  it("restricts records to the current organization", () => {
    expect(sql).toContain(
      "o.organization_id = public.current_org_id()",
    );
  });

  it("matches folio lines using the POS order UUID", () => {
    expect(sql).toContain(
      "f.source_record_uuid = o.id",
    );
    expect(sql).toContain(
      "f.folio_id = o.folio_id",
    );
  });

  it("checks posted Finance journals", () => {
    expect(sql).toContain(
      "x.source_document_type = 'folio_charge:revenue'",
    );
    expect(sql).toContain(
      "x.status = 'posted'",
    );
  });

  it("excludes reversed accounting journals", () => {
    expect(sql).toContain(
      "x.reversed_by_journal_id IS NULL",
    );
    expect(sql).toContain(
      "x.journal_type <> 'reversal'",
    );
  });

  it("detects conflicting direct POS postings", () => {
    expect(sql).toContain(
      "'duplicate-posting-risk'",
    );
    expect(sql).toContain(
      "x.source_document_type LIKE 'pos_order:%'",
    );
  });

  it("checks actual journal lines", () => {
    expect(sql).toContain(
      "public.journal_entry_lines",
    );
    expect(sql).toContain(
      "sum(l.debit)",
    );
    expect(sql).toContain(
      "sum(l.credit)",
    );
  });

  it("does not automatically reconcile partial transfers", () => {
    expect(sql).toContain(
      "'partial-payment-review'",
    );
  });

  it("does not claim official revenue reconciliation", () => {
    expect(sql).toContain(
      "'structurally-matched'",
    );
  });

  it("uses Kenya operational date boundaries", () => {
    expect(sql).toContain(
      "AT TIME ZONE 'Africa/Nairobi'",
    );
  });

  it("does not mutate financial records", () => {
    expect(sql).not.toMatch(
      /\bINSERT\s+INTO\b/i,
    );
    expect(sql).not.toMatch(
      /\bUPDATE\s+public\./i,
    );
    expect(sql).not.toMatch(
      /\bDELETE\s+FROM\b/i,
    );
  });
});
