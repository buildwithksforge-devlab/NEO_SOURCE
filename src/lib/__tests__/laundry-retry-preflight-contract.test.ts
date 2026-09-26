import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations/20260924160000_laundry_retry_preflight_guard.sql"),
  "utf8",
);

describe("laundry posting retry preflight", () => {
  it("blocks before Finance when folio linkage is absent", () => {
    expect(sql).toContain("_row.folio_id IS NULL OR _row.folio_line_id IS NULL");
    expect(sql).toContain("'missing_folio_charge'");
    expect(sql.indexOf("missing_folio_charge")).toBeLessThan(sql.indexOf("neo_finance_post_source"));
  });
});
