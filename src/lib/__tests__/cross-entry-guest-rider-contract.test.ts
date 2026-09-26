import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(
  join(root, "supabase/migrations/20260924150000_cross_entry_guest_rider_guards.sql"),
  "utf8",
);

describe("Guest / Work / Rider cross-entry guards", () => {
  it("posts Guest room-service charges against the folio's canonical organisation", () => {
    expect(migration).toContain("WHEN public.neo_system_posting()");
    expect(migration).toContain("THEN (SELECT organization_id FROM public.folios WHERE id = _folio)");
    expect(migration).toContain("ELSE public.current_org_id()");
  });

  it("allows only the signed-in customer to cancel their own unpaid eligible POS order", () => {
    expect(migration).toContain("current_setting('neo.guest_cancel'");
    expect(migration).toContain("NEW.customer_id IS NOT DISTINCT FROM public.my_customer_id()");
    expect(migration).toContain("OLD.payment_status,'unpaid') NOT IN ('paid','charged','refunded')");
    expect(migration).toContain("set_config('neo.guest_cancel','on',true)");
  });

  it("does not let a Rider collect before Kitchen is ready", () => {
    expect(migration).toContain("coalesce(_d.kitchen_status,'') NOT IN ('ready','completed')");
    expect(migration).toContain("Order is not ready for pickup");
    expect(migration).toContain("Collect the order first");
  });
});
