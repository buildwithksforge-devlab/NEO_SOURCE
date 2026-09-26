import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { reorderQuantityFor } from "@/lib/inventory-data";

const migrations = (() => {
  const dir = resolve(process.cwd(), "supabase/migrations");
  return readdirSync(dir)
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .join("\n");
})();

const hook = readFileSync(resolve(process.cwd(), "src/lib/inventory-data.ts"), "utf8");

describe("low stock → draft purchase request", () => {
  it("buys back to par, not merely to the reorder point", () => {
    // 16 on hand, reorder point 20, par 50 => 34.
    expect(
      reorderQuantityFor({ on_hand: 16, min_level: 20, par_level: 50 } as never),
    ).toBe(34);
  });

  it("writes header and line through one atomic canonical call", () => {
    expect(hook).toContain("neo_purchase_request_from_reorder");
    // No two-step client insert that could leave an orphan header behind.
    expect(hook).not.toContain('from("purchase_requests").insert');
    expect(hook).not.toContain('from("purchase_request_lines").insert');
    // And never an order.
    expect(hook).not.toContain('from("purchase_orders").insert');
  });

  it("is guarded in the database, not only by a client-side lookup", () => {
    expect(migrations).toContain("purchase_requests_open_source_reference_uidx");
    expect(migrations).toMatch(
      /CREATE UNIQUE INDEX[^;]*purchase_requests[^;]*organization_id, branch_id, source_reference/s,
    );
    // The guard only binds while the earlier request is still open.
    expect(migrations).toMatch(
      /source_reference IS NOT NULL\s*AND status IN \('draft','submitted','pending','pending-approval'\)/,
    );
  });

  it("turns a lost concurrent race into the first request, not a failure", () => {
    // Two simultaneous clicks both pass the SELECT; the loser hits the unique
    // index and must return the winner's request rather than erroring.
    expect(migrations).toContain("EXCEPTION WHEN unique_violation THEN");
    expect(migrations).toMatch(/unique_violation THEN[\s\S]{0,600}'duplicate', true/);
  });

  it("keys idempotency deterministically by property and stock item", () => {
    expect(migrations).toContain("v_ref := 'reorder:' || _branch::text || ':' || _stock_item::text");
  });

  it("only ever creates a draft, never a purchase order", () => {
    const start = migrations.lastIndexOf(
      "CREATE OR REPLACE FUNCTION public.neo_purchase_request_from_reorder",
    );
    const fn = migrations.slice(start, migrations.indexOf("$function$;", start));
    expect(fn).toContain("'draft'");
    expect(fn).not.toContain("purchase_orders");
  });
});

describe("concurrent retries against the database guard", () => {
  /** Faithful model of the partial unique index the migration installs. */
  function makeStore() {
    const open = new Map<string, string>();
    let n = 0;
    return {
      raise(ref: string) {
        const existing = open.get(ref);
        if (existing) return { duplicate: true, request_id: existing };
        const id = `pr-${++n}`;
        open.set(ref, id);
        return { duplicate: false, request_id: id };
      },
      count: () => open.size,
    };
  }

  it("creates exactly one open request for repeated clicks on the same item", async () => {
    const store = makeStore();
    const ref = "reorder:branch-1:item-1";
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => store.raise(ref)),
    );
    expect(store.count()).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.request_id)).size).toBe(1);
  });

  it("keeps different properties and different items independent", () => {
    const store = makeStore();
    store.raise("reorder:branch-1:item-1");
    store.raise("reorder:branch-2:item-1");
    store.raise("reorder:branch-1:item-2");
    store.raise("reorder:branch-1:item-1");
    expect(store.count()).toBe(3);
  });
});
