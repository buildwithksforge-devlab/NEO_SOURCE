import { describe, expect, it } from "vitest";
import {
  ENTITY_KINDS,
  WORKFLOWS,
  allowedTransitions,
  assertTransition,
  initialState,
  isTerminal,
  missingCanonicalFacts,
  nextActionFor,
  ownerFor,
  transitionAllowed,
} from "@/lib/canonical-workflow";

describe("canonical workflow definitions", () => {
  it("covers every transaction family the operating system runs on", () => {
    expect(ENTITY_KINDS).toEqual([
      "reservation",
      "payment",
      "folio",
      "pos_order",
      "kds_ticket",
      "grn",
      "stock_movement",
      "requisition",
      "purchase_order",
      "supplier_invoice",
      "event_booking",
      "work_order",
    ]);
  });

  it("only points at states that exist in the same workflow", () => {
    for (const kind of ENTITY_KINDS) {
      const known = new Set(WORKFLOWS[kind].states.map((s) => s.state));
      for (const state of WORKFLOWS[kind].states) {
        for (const target of state.next) {
          expect(known.has(target), `${kind}: ${state.state} → ${target}`).toBe(true);
        }
      }
    }
  });

  it("gives every non-terminal state an owner and a next action", () => {
    for (const kind of ENTITY_KINDS) {
      for (const state of WORKFLOWS[kind].states) {
        expect(ownerFor(kind, state.state)).toBeTruthy();
        if (!state.terminal) expect(nextActionFor(kind, state.state)).toBeTruthy();
        else expect(nextActionFor(kind, state.state)).toBeNull();
      }
    }
  });

  it("lets any live record be cancelled or failed without a bespoke rule", () => {
    expect(transitionAllowed("requisition", "submitted", "cancelled")).toBe(true);
    expect(transitionAllowed("pos_order", "sent", "failed")).toBe(true);
    expect(allowedTransitions("payment", "reconciled")).toEqual([]);
  });
});

describe("transition enforcement", () => {
  it("walks the guest-money conveyor in order", () => {
    const path = ["reserved", "deposit_held", "checked_in", "in_house", "checked_out", "settled"];
    let from = initialState("reservation");
    for (const to of path) {
      expect(() => assertTransition("reservation", from, to)).not.toThrow();
      from = to;
    }
    expect(isTerminal("reservation", "settled")).toBe(true);
  });

  it("refuses a skipped stage", () => {
    expect(() => assertTransition("grn", "draft", "posted")).toThrow(/cannot move/i);
    expect(() => assertTransition("supplier_invoice", "captured", "paid")).toThrow(/cannot move/i);
  });

  it("refuses a state that is not part of the workflow", () => {
    expect(() => assertTransition("work_order", "assigned", "shipped")).toThrow(/not a state/i);
  });

  it("treats a repeat of the current state as idempotent, not illegal", () => {
    expect(() => assertTransition("kds_ticket", "ready", "ready")).not.toThrow();
  });

  it("refuses to move a finished record", () => {
    expect(() => assertTransition("event_booking", "paid", "invoiced")).toThrow(/final/i);
  });
});

describe("canonical identity", () => {
  const base = {
    kind: "payment" as const,
    sourceId: "11111111-1111-1111-1111-111111111111",
    organizationId: "22222222-2222-2222-2222-222222222222",
    branchId: null,
    reference: "RCT-1",
    state: "captured",
    actorId: null,
    idempotencyKey: "payment:11111111",
  };

  it("accepts a fully identified record", () => {
    expect(missingCanonicalFacts(base)).toEqual([]);
  });

  it("names what is missing rather than persisting a partial identity", () => {
    expect(missingCanonicalFacts({ ...base, idempotencyKey: "" })).toContain("idempotencyKey");
    expect(missingCanonicalFacts({ ...base, organizationId: "" })).toContain("organizationId");
    expect(missingCanonicalFacts({ ...base, state: "somewhere" })).toContain("state");
  });
});
