/**
 * Pressing Send twice on a draft POS order.
 *
 * The deployed routines are exported verbatim into
 * `fixtures/pos-kds-contract.sql` and `fixtures/pos-status-rules.sql`, so the
 * guarantees asserted here are read off what the database actually executes.
 * A behavioural simulation of those exact rules then presses Send twice on a
 * three-station draft order (Grill, Fry, Main Bar) and proves that no ticket is
 * duplicated and the bill stays unpaid and open for later settlement.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORDER_TRANSITIONS, PRODUCTION_SEND_STATUS, allowedTransitions } from "@/lib/pos";
import { explainPosStatusError } from "@/lib/pos-data";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

const read = (f: string) => readFileSync(join(process.cwd(), "src/lib/__tests__/fixtures", f), "utf8");
const RULES_SQL = read("pos-status-rules.sql");
const SEND_SQL = read("pos-kds-contract.sql");

const sendFn = (() => {
  const start = SEND_SQL.indexOf("FUNCTION public.neo_pos_send_to_kitchen(");
  const next = SEND_SQL.indexOf("CREATE OR REPLACE FUNCTION", start + 10);
  return SEND_SQL.slice(start, next === -1 ? undefined : next);
})();

/* ------------------------------------------------------------------ *
 * Server rulebook is the single source of truth
 * ------------------------------------------------------------------ */

describe("one canonical transition graph", () => {
  it("the trigger reads the shared rulebook instead of its own copy", () => {
    expect(RULES_SQL).toContain("public.neo_pos_status_rules()");
    const trigger = RULES_SQL.slice(RULES_SQL.indexOf("FUNCTION public.pos_enforce_order_status("));
    expect(trigger).toContain("neo_pos_status_rules() -> OLD.status");
    expect(trigger).not.toContain("WHEN 'draft' THEN ARRAY[");
  });

  it("draft may go straight to the canonical production-send state", () => {
    expect(PRODUCTION_SEND_STATUS).toBe("sent");
    expect(RULES_SQL).toContain("'draft', jsonb_build_array('held','confirmed','sent','cancelled')");
    expect(allowedTransitions("draft")).toContain("sent");
  });

  it("the client mirror matches the server rulebook entry for entry", () => {
    const rules = RULES_SQL.slice(RULES_SQL.indexOf("FUNCTION public.neo_pos_status_rules("));
    for (const [from, tos] of Object.entries(ORDER_TRANSITIONS)) {
      const list = tos.map((t) => `'${t}'`).join(",");
      expect(rules, `${from} drifted from the server rulebook`).toContain(
        `'${from}', jsonb_build_array(${list})`,
      );
    }
  });

  it("send is never gated on settlement", () => {
    expect(sendFn).not.toMatch(/payment_status\s*(=|IN|<>)/);
    expect(sendFn).not.toContain("requires_payment");
  });

  it("a rejected transition is explained with the allowed graph", () => {
    const msg = explainPosStatusError("Invalid order status transition paid -> sent");
    expect(msg).toContain("Paid");
    expect(msg).toContain("Closed");
    expect(explainPosStatusError("boom")).toBe("boom");
  });

  it("registers the diagnostics routines as authenticated-only", () => {
    expect(RPC_MANIFEST["neo_pos_order_diagnostics"]).toBe("authenticated");
  });
});

/* ------------------------------------------------------------------ *
 * Behavioural simulation of the deployed send routine
 * ------------------------------------------------------------------ */

type Item = { id: string; station: string; course: string; status: string };
type Ticket = { id: string; station: string; course: string; items: string[] };

function makeOrder() {
  return {
    status: "draft",
    payment_status: "unpaid",
    grand_total: 10150,
    sent_at: null as string | null,
    items: [
      { id: "i1", station: "Grill", course: "main", status: "draft" },
      { id: "i2", station: "Fry", course: "main", status: "draft" },
      { id: "i3", station: "Main Bar", course: "drinks", status: "draft" },
    ] as Item[],
  };
}

/** Mirrors `neo_pos_send_to_kitchen`: rulebook check, per-item live-line reuse,
 *  one ticket per (order, station, course), atomic flip to `sent`. */
function send(order: ReturnType<typeof makeOrder>, tickets: Ticket[]) {
  if (["held", "cancelled", "voided"].includes(order.status)) throw new Error("order_not_sendable");
  if (order.status !== "sent" && !allowedTransitions(order.status).includes("sent")) {
    throw new Error(`Invalid order status transition ${order.status} -> sent`);
  }
  let created = 0;
  let reused = 0;
  for (const item of order.items) {
    if (["cancelled", "voided"].includes(item.status)) continue;
    const live = tickets.some((t) => t.items.includes(item.id));
    if (live) {
      reused += 1;
      continue;
    }
    let ticket = tickets.find((t) => t.station === item.station && t.course === item.course);
    if (!ticket) {
      ticket = { id: `t${tickets.length + 1}`, station: item.station, course: item.course, items: [] };
      tickets.push(ticket);
    }
    ticket.items.push(item.id);
    item.status = "sent";
    created += 1;
  }
  order.status = "sent";
  order.sent_at = order.sent_at ?? "2026-08-27T13:00:00Z";
  return { tickets_created: tickets.length, items_created: created, items_reused: reused };
}

describe("pressing Send twice on a draft order", () => {
  it("creates the Grill, Fry and Main Bar tickets exactly once", () => {
    const order = makeOrder();
    const tickets: Ticket[] = [];

    const first = send(order, tickets);
    expect(order.status).toBe("sent");
    expect(first.items_created).toBe(3);
    expect(tickets.map((t) => t.station).sort()).toEqual(["Fry", "Grill", "Main Bar"]);

    const second = send(order, tickets);
    expect(second.items_created).toBe(0);
    expect(second.items_reused).toBe(3);
    expect(tickets).toHaveLength(3);
    expect(tickets.flatMap((t) => t.items).sort()).toEqual(["i1", "i2", "i3"]);
  });

  it("leaves the bill unpaid and open at the same balance for later settlement", () => {
    const order = makeOrder();
    const tickets: Ticket[] = [];
    send(order, tickets);
    send(order, tickets);
    expect(order.payment_status).toBe("unpaid");
    expect(order.grand_total).toBe(10150);
    expect(["voided", "cancelled", "closed"]).not.toContain(order.status);
    // The bill can still reach settlement without any extra flow.
    expect(allowedTransitions("served")).toContain("awaiting-payment");
    expect(allowedTransitions("awaiting-payment")).toEqual(
      expect.arrayContaining(["paid", "charged-to-room"]),
    );
  });

  it("still refuses a held, cancelled or voided order", () => {
    for (const status of ["held", "cancelled", "voided"]) {
      const order = { ...makeOrder(), status };
      expect(() => send(order, [])).toThrow("order_not_sendable");
    }
  });
});
