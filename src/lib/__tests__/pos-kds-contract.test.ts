/**
 * POS ↔ KDS production contract.
 *
 * The deployed routines are exported verbatim into
 * `fixtures/pos-kds-contract.sql`, so these assertions run against what the
 * database actually executes, not against a hand-written description of it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveTicketStatus } from "@/lib/kitchen-tickets";
import { POS_KDS_LABELS } from "@/lib/ops-reconciliation";
import { ROLE_ACCESS_SCOPES, actionsForScope } from "@/lib/role-templates";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

const SQL = readFileSync(join(process.cwd(), "src/lib/__tests__/fixtures/pos-kds-contract.sql"), "utf8");

const fn = (name: string) => {
  const start = SQL.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} missing from fixture`).toBeGreaterThan(-1);
  const next = SQL.indexOf("CREATE OR REPLACE FUNCTION", start + 10);
  return SQL.slice(start, next === -1 ? undefined : next);
};

const send = fn("neo_pos_send_to_kitchen");
const legacy = fn("kitchen_route_order");
const reconcile = fn("neo_pos_kds_reconciliation");
const rollup = fn("pos_rollup_order_status");
const ticketTransition = fn("neo_kitchen_ticket_transition");
const itemTransition = fn("neo_kitchen_item_transition");
const queue = fn("neo_kitchen_queue");

describe("one authoritative send path", () => {
  it("legacy kitchen_route_order only delegates and never generates tickets itself", () => {
    expect(legacy).toContain("neo_pos_send_to_kitchen");
    expect(legacy).not.toContain("INSERT INTO public.station_tickets");
    expect(legacy).not.toContain("INSERT INTO public.station_ticket_items");
  });

  it("the send routine is the only fixture routine inserting kitchen work", () => {
    for (const [name, body] of [
      ["reconciliation", reconcile],
      ["ticket transition", ticketTransition],
      ["queue", queue],
    ] as const) {
      expect(body, `${name} must not create tickets`).not.toContain("INSERT INTO public.station_tickets (");
    }
    expect(send).toContain("INSERT INTO public.station_tickets (");
  });
});

describe("exactly-once ticket creation", () => {
  it("accepts the POS draft lifecycle and atomically marks a successful send", () => {
    expect(send).not.toContain("_o.status IN ('draft','held','cancelled','voided')");
    expect(send).toContain("_o.status IN ('held','cancelled','voided')");
    expect(send).toContain("_o.status IN ('draft','open','new','draft-sent')");
    expect(send).toContain("status = 'sent', sent_at = COALESCE(sent_at, now())");
  });

  it("serialises concurrent sends of the same order", () => {
    expect(send).toContain("pg_advisory_xact_lock");
  });

  it("skips a source item that already has a live ticket line", () => {
    expect(send).toContain("EXISTS (SELECT 1 FROM public.station_ticket_items sti");
    expect(send).toContain("sti.order_item_id = _it.id AND sti.remake_of_id IS NULL");
    expect(send).toContain("_reused := _reused + 1");
  });

  it("keys tickets by order, station and course and swallows the duplicate insert", () => {
    expect(send).toContain("ON CONFLICT (order_id, COALESCE(station_id");
    expect(send).toContain("DO NOTHING");
    expect(send).toContain("EXCEPTION WHEN unique_violation THEN");
  });

  it("requires an attempt key and reports created versus reused work", () => {
    expect(send).toContain("attempt_key_required");
    for (const key of ["tickets_created", "items_created", "items_reused", "unassigned_station"]) {
      expect(send).toContain(`'${key}'`);
    }
  });
});

describe("station routing", () => {
  it("resolves every item through the canonical resolver, native or imported", () => {
    expect(send).toContain("neo_kitchen_route_order_item(_it.id)");
    expect(send).not.toMatch(/FROM public\.operational_stations[\s\S]{0,120}LIMIT 1\)\s*INTO _station/);
  });

  it("persists the resolved station back onto the source item", () => {
    expect(send).toContain("UPDATE public.pos_order_items SET station_id = _station");
  });

  it("raises an explicit unassigned-station exception instead of a default kitchen", () => {
    expect(send).toContain("'unassigned-station'");
    expect(send).toContain("_unassigned := _unassigned + 1");
  });
});

describe("KDS → POS status feedback", () => {
  it("kitchen item transitions write back to the source POS item", () => {
    expect(itemTransition).toContain("pos_order_items");
  });

  it("order status is derived from child items, never from one ready item", () => {
    expect(rollup).toContain("_ready = _total THEN 'ready'");
    expect(rollup).toContain("_ready > 0 THEN 'partially-ready'");
    expect(rollup).toContain("_served = _total THEN 'served'");
  });

  it("a multi-item order with one ready item is only partially ready", () => {
    expect(deriveTicketStatus(["ready", "preparing"])).not.toBe("ready");
    expect(deriveTicketStatus(["ready", "ready"])).toBe("ready");
  });
});

describe("ownership and station scope", () => {
  it("the send routine refuses another waiter's order without supervisory capability", () => {
    expect(send).toContain("_o.waiter_id = auth.uid() OR _o.created_by = auth.uid()");
    expect(send).toContain("has_permission('restaurant','orders.manage')");
    expect(send).toContain("insufficient_privilege");
  });

  it("the send routine enforces organisation and property scope", () => {
    expect(send).toContain("public.current_org_id()");
    expect(send).toContain("neo_branch_in_scope(_o.branch_id)");
    expect(send).toContain("branch_out_of_scope");
  });

  it("the kitchen queue runs as the caller so station row scope comes from RLS, not the UI", () => {
    const header = queue.slice(0, queue.indexOf("AS $function$"));
    expect(header).not.toContain("SECURITY DEFINER");
    expect(queue).toContain("FROM public.station_tickets t");
  });

  it("a waiter's scope grants no cross-service authority", () => {
    expect(ROLE_ACCESS_SCOPES["waiter"]).toBe("self");
    expect(actionsForScope("self")).not.toContain("approve");
  });
});

describe("void and discount approval authority", () => {
  const approvers = Object.entries(ROLE_ACCESS_SCOPES)
    .filter(([, scope]) => actionsForScope(scope).includes("void"))
    .map(([role]) => role);

  it("only organisation-scope roles carry void or refund authority", () => {
    for (const role of approvers) expect(ROLE_ACCESS_SCOPES[role]).toBe("organisation");
  });

  it("service, kitchen and finance line roles cannot approve or void", () => {
    for (const role of ["waiter", "cashier", "chef", "barista", "accountant"]) {
      const scope = ROLE_ACCESS_SCOPES[role];
      if (!scope) continue;
      const actions = actionsForScope(scope);
      expect(actions, `${role} must not void`).not.toContain("void");
      expect(actions, `${role} must not refund`).not.toContain("refund");
    }
  });

  it("cancellation of a source item is visible to the kitchen as drift, not silently dropped", () => {
    expect(reconcile).toContain("cancelled_still_active");
    expect(reconcile).toContain("i.status IN ('cancelled','voided')");
  });
});

describe("reconciliation monitor", () => {
  const groups = [
    "missing_tickets",
    "orphan_ticket_items",
    "duplicate_sources",
    "unassigned_station",
    "status_conflicts",
    "cancelled_still_active",
  ];

  it("computes every required exception class", () => {
    for (const g of groups) expect(reconcile).toContain(`'${g}'`);
  });

  it("flags POS terminal states that contradict live kitchen work", () => {
    expect(reconcile).toContain("i.status IN ('ready','served')");
    expect(reconcile).toContain("t.status IN ('new','accepted','preparing','remaking')");
  });

  it("is organisation and property scoped and denies unauthorised callers", () => {
    expect(reconcile).toContain("public.current_org_id()");
    expect(reconcile).toContain("neo_branch_in_scope(o.branch_id)");
    expect(reconcile).toContain("insufficient_privilege");
  });

  it("healthy only when every class is empty", () => {
    for (const g of groups) expect(reconcile).toContain(g);
    expect(reconcile).toContain("'healthy'");
  });

  it("the UI surfaces each exception class", () => {
    for (const g of groups) expect(Object.keys(POS_KDS_LABELS)).toContain(g);
  });
});

describe("routine registration", () => {
  it("declares the new routine as authenticated-only", () => {
    expect(RPC_MANIFEST["neo_pos_send_to_kitchen"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_pos_kds_reconciliation"]).toBe("authenticated");
  });
});
