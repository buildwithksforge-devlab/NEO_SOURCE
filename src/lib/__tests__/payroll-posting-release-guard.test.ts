import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../../supabase/migrations/20260924133000_payroll_posting_release_guard.sql", import.meta.url),
  "utf8",
);

describe("payroll payslip release guard", () => {
  it("requires an exported, posted payroll before release", () => {
    expect(sql).toContain("p.status = 'exported'");
    expect(sql).toContain("p.posted_journal_id IS NOT NULL");
    expect(sql).toContain("p.posted_at IS NOT NULL");
    expect(sql).toContain("Post this payroll to Finance before releasing payslips");
  });

  it("preserves employee self-service isolation while hiding premature releases", () => {
    expect(sql).toContain("e.profile_id = auth.uid()");
    expect(sql).toContain("p.payslips_released_at IS NOT NULL");
  });
});
