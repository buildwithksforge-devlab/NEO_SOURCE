import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260924134500_pos_prepaid_service_guard.sql"),
  "utf8",
);

describe("pay-first POS service integrity", () => {
  it("allows financial settlement to remain separate from service completion", () => {
    expect(sql).toContain("Prepayment is allowed");
    expect(sql).toContain("payment_status = _pay_status");
    expect(sql).toContain("_open_items = 0");
  });

  it("refuses paid/closed operational status while item work remains open", () => {
    expect(sql).toContain("NEW.status IN ('paid','closed','completed','settled')");
    expect(sql).toContain("This order still has % open item(s)");
  });

  it("does not consume stock merely because the bill is paid", () => {
    expect(sql).toContain("NOT IN ('completed','closed')");
    expect(sql).not.toContain("NOT IN ('completed','paid','closed')");
  });

  it("closes an older prepaid order after its final item becomes terminal", () => {
    expect(sql).toContain("ELSIF _o.status = 'paid' THEN");
    expect(sql).toContain("do not recreate the transaction or its receipt/journal");
  });
});
