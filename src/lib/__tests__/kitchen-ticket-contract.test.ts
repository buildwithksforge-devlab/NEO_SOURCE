import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ITEM_TRANSITIONS,
  TICKET_TRANSITIONS,
  deriveTicketStatus,
  isTerminalItem,
  itemActions,
  canonicalTicketStatus,
  isTerminalTicket,
  ticketActions,
  eligibleTickets,
  ticketRoutingException,
  STATION_ROUTING_PRECEDENCE,
  type KitchenTicket,
} from "@/lib/kitchen-tickets";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

const kds = readFileSync("src/routes/_shell.pos.kds.tsx", "utf8");
const queue = readFileSync("src/routes/_shell.kitchen.queue.tsx", "utf8");
const card = readFileSync("src/components/kitchen/TicketCard.tsx", "utf8");

describe("one canonical ticket source", () => {
  it("both live pages read the shared queue hook", () => {
    for (const file of [kds, queue]) {
      expect(file).toContain("useKitchenTickets");
      expect(file).toContain("@/lib/kitchen-tickets");
    }
  });

  it("neither page queries station_tickets directly", () => {
    for (const file of [kds, queue]) {
      expect(file).not.toContain("station_tickets");
      expect(file).not.toContain("useStationTickets");
      expect(file).not.toContain("useKitchenQueue(");
    }
  });

  it("both pages mutate through the shared transition contract", () => {
    for (const file of [kds, queue]) {
      expect(file).toContain("useKitchenTicketTransition");
      expect(file).toContain("useKitchenTicketDelay");
    }
  });

  it("both pages render the shared ticket card so fields cannot diverge", () => {
    for (const file of [kds, queue]) {
      expect(file).toContain("TicketCard");
    }
  });

  it("registers every new routine in the callable manifest", () => {
    for (const fn of [
      "neo_kitchen_queue",
      "neo_kitchen_ticket_transition",
      "neo_kitchen_ticket_delay",
      "neo_kitchen_backfill_tickets",
    ]) {
      expect(RPC_MANIFEST[fn]).toBe("authenticated");
    }
  });
});

describe("transition state machine", () => {
  it("accepts only the forward path", () => {
    expect(TICKET_TRANSITIONS["new"]).toContain("accepted");
    expect(TICKET_TRANSITIONS["accepted"]).toContain("preparing");
    expect(TICKET_TRANSITIONS["preparing"]).toContain("ready");
    expect(TICKET_TRANSITIONS["ready"]).toContain("served");
    expect(TICKET_TRANSITIONS["served"]).toContain("completed");
  });

  it("rejects skipped and backward moves", () => {
    expect(TICKET_TRANSITIONS["new"]).not.toContain("ready");
    expect(TICKET_TRANSITIONS["preparing"]).not.toContain("new");
    expect(TICKET_TRANSITIONS["ready"]).not.toContain("preparing");
  });

  it("offers no action from terminal states", () => {
    expect(ticketActions("completed")).toHaveLength(0);
    expect(ticketActions("cancelled")).toHaveLength(0);
    expect(isTerminalTicket("completed")).toBe(true);
    expect(isTerminalTicket("ready")).toBe(false);
  });

  it("cancellation always demands a reason", () => {
    const cancel = ticketActions("new").find((a) => a.to === "cancelled");
    expect(cancel?.needsReason).toBe(true);
  });

  it("cannot be cancelled once the food is out", () => {
    expect(TICKET_TRANSITIONS["ready"]).not.toContain("cancelled");
    expect(TICKET_TRANSITIONS["served"]).not.toContain("cancelled");
  });

  it("treats delay as metadata, never a lifecycle state", () => {
    expect(TICKET_TRANSITIONS["delayed"]).toBeUndefined();
    expect(canonicalTicketStatus("delayed")).toBe("preparing");
    expect(Object.values(TICKET_TRANSITIONS).flat()).not.toContain("delayed");
  });

  it("normalises legacy status spellings", () => {
    expect(canonicalTicketStatus("queued")).toBe("new");
    expect(canonicalTicketStatus("in_progress")).toBe("preparing");
    expect(canonicalTicketStatus("in-preparation")).toBe("preparing");
    expect(canonicalTicketStatus("partially_ready")).toBe("partially-ready");
    expect(canonicalTicketStatus(null)).toBe("new");
  });
});

describe("scope and truthful states", () => {
  it("hides All stations from station-scoped users", () => {
    for (const file of [kds, queue]) {
      expect(file).toContain("allowAll ? <SelectItem value=\"all\">All stations</SelectItem> : null");
    }
  });

  it("shows empty only after a successful zero-row load", () => {
    for (const file of [kds, queue]) {
      expect(file).toContain("!queue.isLoading && !queue.error && queue.tickets.length === 0");
    }
  });

  it("shares one invalidation key so a move on either page updates both", () => {
    const lib = readFileSync("src/lib/kitchen-tickets.ts", "utf8");
    expect(lib).toContain('KITCHEN_TICKETS_QUERY_KEY = ["kitchen", "tickets"]');
    expect(lib).toContain("useKitchenTicketRealtime");
  });
});

describe("item lifecycle is the same state-machine family", () => {
  it("uses the canonical item RPC, never the legacy hook", () => {
    expect(queue).toContain("useKitchenItemTransition");
    expect(queue).not.toContain("useItemTransition");
    expect(queue).not.toContain("ITEM_TRANSITIONS");
    expect(RPC_MANIFEST["neo_kitchen_item_transition"]).toBe("authenticated");
  });

  it("derives item actions from the shared contract", () => {
    expect(queue).toContain("itemActions(i.status)");
    expect(itemActions("new").map((a) => a.to)).toEqual(["accepted", "cancel-pending"]);
    expect(itemActions("preparing").map((a) => a.to)).toContain("ready");
  });

  it("rejects backward, skipped and terminal item moves", () => {
    expect(ITEM_TRANSITIONS["new"]).not.toContain("ready");
    expect(ITEM_TRANSITIONS["preparing"]).not.toContain("new");
    expect(itemActions("completed")).toHaveLength(0);
    expect(itemActions("cancelled")).toHaveLength(0);
    expect(isTerminalItem("cancelled")).toBe(true);
    expect(isTerminalItem("ready")).toBe(false);
  });

  it("demands a reason for cancellation and remake requests", () => {
    expect(itemActions("new").find((a) => a.to === "cancel-pending")?.needsReason).toBe(true);
    expect(itemActions("ready").find((a) => a.to === "remake-requested")?.needsReason).toBe(true);
    expect(itemActions("new").find((a) => a.to === "accepted")?.needsReason).toBe(false);
  });
});

describe("ticket header is always derived from its items", () => {
  it("all items new => new (the Ready/New contradiction is impossible)", () => {
    expect(deriveTicketStatus(["new", "new"])).toBe("new");
    expect(deriveTicketStatus(Array(15).fill("new"))).toBe("new");
  });

  it("accepted mix without preparation => accepted", () => {
    expect(deriveTicketStatus(["accepted", "new"])).toBe("accepted");
  });

  it("any preparing and none ready => preparing", () => {
    expect(deriveTicketStatus(["preparing", "new", "accepted"])).toBe("preparing");
  });

  it("ready mixed with earlier open states => partially-ready", () => {
    expect(deriveTicketStatus(["ready", "preparing"])).toBe("partially-ready");
    expect(deriveTicketStatus(["ready", "new"])).toBe("partially-ready");
  });

  it("all ready => ready; served and completed propagate", () => {
    expect(deriveTicketStatus(["ready", "collected"])).toBe("ready");
    expect(deriveTicketStatus(["served", "served"])).toBe("served");
    expect(deriveTicketStatus(["completed", "completed"])).toBe("completed");
    expect(deriveTicketStatus(["served", "ready"])).toBe("ready");
  });

  it("cancelled items are excluded; an all-cancelled ticket is cancelled", () => {
    expect(deriveTicketStatus(["cancelled", "ready"])).toBe("ready");
    expect(deriveTicketStatus(["cancelled", "cancelled"])).toBe("cancelled");
  });

  it("never derives a header the ticket contract cannot act on", () => {
    for (const s of ["new", "accepted", "preparing", "partially-ready", "ready", "served"]) {
      expect(TICKET_TRANSITIONS[s]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("bulk ticket eligibility", () => {
  const t = (id: string, status: string) => ({ ticket_id: id, status }) as unknown as KitchenTicket;

  it("only selects tickets whose current status permits the requested move", () => {
    const chosen = [t("a", "new"), t("b", "accepted"), t("c", "ready")];
    expect(eligibleTickets(chosen, "accepted").map((x) => x.ticket_id)).toEqual(["a"]);
    expect(eligibleTickets(chosen, "preparing").map((x) => x.ticket_id)).toEqual(["b"]);
    expect(eligibleTickets(chosen, "served").map((x) => x.ticket_id)).toEqual(["c"]);
  });

  it("never advances terminal tickets", () => {
    expect(eligibleTickets([t("d", "completed"), t("e", "cancelled")], "served")).toHaveLength(0);
  });
});

describe("production-station routing contract", () => {
  it("keeps the deterministic resolver precedence: rules before persisted, persisted before menu defaults", () => {
    expect(STATION_ROUTING_PRECEDENCE).toEqual([
      "rule-item",
      "rule-category",
      "order-item",
      "menu-item",
      "menu-category",
      "missing-routing",
    ]);
    expect(STATION_ROUTING_PRECEDENCE.indexOf("rule-item")).toBeLessThan(
      STATION_ROUTING_PRECEDENCE.indexOf("rule-category"),
    );
    expect(STATION_ROUTING_PRECEDENCE.indexOf("rule-category")).toBeLessThan(
      STATION_ROUTING_PRECEDENCE.indexOf("order-item"),
    );
    expect(STATION_ROUTING_PRECEDENCE.at(-1)).toBe("missing-routing");
  });

  it("raises a routing exception only when the canonical station is absent", () => {
    expect(ticketRoutingException({ station_id: null, station_missing: true })).toBe(true);
    expect(ticketRoutingException({ station_id: "s1", station_missing: false })).toBe(false);
  });

  it("both pages render the shared card, so the exception text cannot diverge", () => {
    for (const file of [kds, queue]) expect(file).toContain("TicketCard");
    expect(card).toContain("ticketRoutingException(ticket)");
    expect(card).toContain("ROUTING_EXCEPTION_MESSAGE");
    expect(card).not.toContain("Assign a station in Kitchen settings");
  });

  it("registers the routing and reconciliation routines as authenticated-only", () => {
    for (const fn of [
      "neo_kitchen_reconcile_stations",
    ]) {
      expect(RPC_MANIFEST[fn as keyof typeof RPC_MANIFEST]).toBe("authenticated");
    }
  });
});
