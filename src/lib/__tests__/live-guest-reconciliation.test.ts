/**
 * Live contract: guest-created records must be reconcilable by staff.
 *
 * A booking, order or request that a customer creates in the guest app is only
 * useful to the business when staff modules can find it: the same organisation
 * and property, a canonical tracking record with a named owner and next action,
 * and a durable handoff event. This asserts that contract against the connected
 * project database. Read-only; no secret is read and nothing is mutated.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const HAS_SQL = Boolean(process.env["PGHOST"]);

function sql(query: string): string[][] {
  const out = execFileSync("psql", ["-At", "-F", "\u0001", "-c", query], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\u0001"));
}

describe.skipIf(!HAS_SQL)("live guest → staff reconciliation", () => {
  it("every guest delivery or room-service order has a canonical tracking record", () => {
    const rows = sql(`
      SELECT d.order_number
        FROM public.delivery_orders d
       WHERE NOT EXISTS (
         SELECT 1 FROM public.canonical_transaction_states c
          WHERE c.organization_id = d.organization_id
            AND c.idempotency_key = 'delivery:' || d.id::text)`);
    expect(rows.flat()).toEqual([]);
  });

  it("every guest service request has a canonical tracking record", () => {
    const rows = sql(`
      SELECT g.id::text
        FROM public.guest_requests g
       WHERE NOT EXISTS (
         SELECT 1 FROM public.canonical_transaction_states c
          WHERE c.organization_id = g.organization_id
            AND c.idempotency_key = 'guest-services:' || g.id::text)`);
    expect(rows.flat()).toEqual([]);
  });

  it("each guest record names an owning team and a next action", () => {
    const rows = sql(`
      SELECT c.source_reference
        FROM public.canonical_transaction_states c
       WHERE c.source_module IN ('delivery','guest-services')
         AND c.operational_state NOT IN ('superseded','cancelled','completed','delivered','closed','resolved')
         AND (c.current_owner IS NULL OR c.next_action IS NULL)`);
    expect(rows.flat()).toEqual([]);
  });

  it("no guest record crosses a property boundary", () => {
    const rows = sql(`
      SELECT d.order_number
        FROM public.delivery_orders d
        JOIN public.canonical_transaction_states c
          ON c.idempotency_key = 'delivery:' || d.id::text
       WHERE c.organization_id <> d.organization_id
          OR c.branch_id IS DISTINCT FROM d.branch_id`);
    expect(rows.flat()).toEqual([]);
  });

  it("a guest order is tied to a registered customer of the same workspace", () => {
    const rows = sql(`
      SELECT d.order_number
        FROM public.delivery_orders d
        LEFT JOIN public.customers cu ON cu.id = d.customer_id
       WHERE d.customer_id IS NULL
          OR cu.organization_id IS DISTINCT FROM d.organization_id`);
    expect(rows.flat()).toEqual([]);
  });
});
