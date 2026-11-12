import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { requireBlindReceiptResult } from "@/lib/supply-command-result";
const count = "b6000000-0000-4000-8000-000000000050",
  grn = "b6000000-0000-4000-8000-000000000060";
const safetyMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261112090000_block_virtual_blind_receiving.sql"),
  "utf8",
);
const postingComponent = readFileSync(
  join(process.cwd(), "src/components/inventory/ApprovedReceivingPosting.tsx"),
  "utf8",
);
describe("approved receiving screen evidence", () => {
  it.each([
    null,
    {},
    { ok: false, count_id: count, status: "posted", grn_id: grn },
    { ok: true, count_id: "other", status: "posted", grn_id: grn },
    { ok: true, count_id: count, status: "approved", grn_id: grn },
  ])("rejects an unverified posting %j", (v) =>
    expect(() => requireBlindReceiptResult(v, count)).toThrow(),
  );
  it("keeps stock received distinct from pending Finance", () => {
    const v = {
      ok: true,
      count_id: count,
      status: "posted",
      grn_id: grn,
      lifecycle_result: {
        ok: true,
        receipt_id: grn,
        grn_number: "GRN-1",
        posting: { status: "pending-finance" },
      },
    };
    expect(requireBlindReceiptResult(v, count)).toEqual(v);
  });
  it("accepts a durable replay without inventing a new posting", () =>
    expect(
      requireBlindReceiptResult(
        { ok: true, count_id: count, status: "posted", grn_id: grn, replayed: true },
        count,
      )["grn_id"],
    ).toBe(grn));
  it("blocks explicitly virtual counts in both the queue and the posting RPC", () => {
    expect(safetyMigration).toContain("'posting_block_reason'");
    expect(safetyMigration).toContain("%virtual test only%");
    expect(safetyMigration).toContain("%no actual goods%");
    expect(safetyMigration).toContain("%no real goods%");
    expect(safetyMigration).toContain("%no physical goods%");
    expect(safetyMigration).toContain("%no supplier commitment%");
    expect(safetyMigration).toContain(
      "This count is marked as virtual/test-only; inventory posting is prohibited",
    );
    expect(postingComponent).toContain("!!approved.posting_block_reason");
    expect(postingComponent).toContain("approved.posting_block_reason");
  });
  it("retains the independent receiving maker/poster separation", () => {
    expect(safetyMigration).toContain(
      "IF v_count.submitted_by = auth.uid() THEN",
    );
    expect(safetyMigration).toContain("You cannot post your own receiving count");
  });
});
