import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(
  path.resolve("supabase/migrations/20260924140000_guest_laundry_lifecycle_guard.sql"),
  "utf8",
);

const operations = fs.readFileSync(path.resolve("src/lib/operations-data.ts"), "utf8");
const page = fs.readFileSync(path.resolve("src/routes/_shell.laundry.index.tsx"), "utf8");

describe("guest laundry certification lifecycle", () => {
  it("requires a real guest batch before processing or delivery", () => {
    expect(migration).toContain("b.guest_order_id = NEW.id");
    expect(migration).toContain("Receive this guest laundry into a guest batch");
    expect(migration).toContain("_batch_status <> 'completed'");
  });

  it("requires actor/time and Finance posting before final close", () => {
    expect(migration).toContain("NEW.delivered_at IS NULL OR NEW.delivery_confirmed_by IS NULL");
    expect(migration).toContain("COALESCE(NEW.posting_status,'unposted') <> 'posted'");
    expect(migration).toContain("neo_laundry_retry_posting(_order)");
  });

  it("synchronises guest-facing progress from the real laundry batch", () => {
    expect(migration).toContain("neo_sync_guest_laundry_from_batch");
    expect(migration).toContain("WHEN 'washing' THEN 'washing'");
    expect(migration).toContain("WHEN 'completed' THEN 'ready-for-delivery'");
  });

  it("routes the staff status action through the controlled RPC", () => {
    expect(operations).toContain('"neo_laundry_order_advance"');
    expect(page).toContain("advanceOrder.mutate");
  });
});
