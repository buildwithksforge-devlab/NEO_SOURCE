import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("payment schedule release maker guard", () => {
  const sql = readFileSync(
    "supabase/migrations/20261022120000_payment_schedule_maker_guard.sql",
    "utf8",
  );

  it("blocks release when the maker is missing", () => {
    expect(sql).toContain("IF s.created_by IS NULL THEN");
    expect(sql).toContain("Payment schedule has no maker");
  });

  it("preserves maker/checker separation", () => {
    expect(sql).toContain(
      "s.created_by = auth.uid() AND NOT public.is_org_admin()",
    );
  });

  it("preserves organization and branch scope", () => {
    expect(sql).toContain("organization_id = _org");
    expect(sql).toContain("neo_branch_in_scope");
  });

  it("preserves duplicate-release protection", () => {
    expect(sql).toContain("IF _existing.id IS NOT NULL THEN");
    expect(sql).toContain("'idempotent', true");
  });
});