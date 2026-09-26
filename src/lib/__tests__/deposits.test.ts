import { describe, expect, it } from "vitest";
import { depositGate, depositIdempotencyKey, type DepositPosition } from "@/lib/deposits";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

const position = (over: Partial<DepositPosition> = {}): DepositPosition => ({
  ok: true,
  required: 10000,
  held: 0,
  applied: 0,
  paid: 0,
  outstanding: 10000,
  waiver: null,
  override_id: null,
  may_check_in: false,
  ...over,
});

describe("pre-arrival deposit gate", () => {
  it("blocks check-in while a deposit is outstanding", () => {
    const gate = depositGate(position());
    expect(gate.blocked).toBe(true);
    expect(gate.message).toContain("Deposit outstanding");
  });

  it("releases the gate once the deposit is fully received", () => {
    expect(depositGate(position({ paid: 10000, outstanding: 0 })).blocked).toBe(false);
  });

  it("treats a corporate credit account as a policy waiver, not a payment", () => {
    const gate = depositGate(position({ waiver: "corporate-credit" }));
    expect(gate.blocked).toBe(false);
    expect(gate.message).toContain("corporate credit");
  });

  it("honours an authorised single-use override", () => {
    const gate = depositGate(position({ override_id: "11111111-1111-1111-1111-111111111111" }));
    expect(gate.blocked).toBe(false);
    expect(gate.message).toContain("used once");
  });

  it("never blocks on an unreadable position — the database trigger still guards it", () => {
    expect(depositGate(undefined).blocked).toBe(false);
    expect(depositGate({ ok: false, reason: "Reservation not found" }).blocked).toBe(false);
  });
});

describe("deposit idempotency", () => {
  const intent = {
    reservationId: "res-1",
    propertyId: "prop-1",
    amount: 3250,
    method: "cash",
    businessDate: "2026-08-31",
  };

  it("returns one posting intent per source event and property, so a retry cannot take money twice", () => {
    expect(depositIdempotencyKey(intent)).toBe(depositIdempotencyKey({ ...intent }));
  });

  it("separates a genuinely different intent — other property, amount or day", () => {
    const base = depositIdempotencyKey(intent);
    expect(depositIdempotencyKey({ ...intent, propertyId: "prop-2" })).not.toBe(base);
    expect(depositIdempotencyKey({ ...intent, amount: 1000 })).not.toBe(base);
    expect(depositIdempotencyKey({ ...intent, businessDate: "2026-09-01" })).not.toBe(base);
  });
});

describe("deposit callable surface", () => {
  it("declares every deposit routine as authenticated-only", () => {
    for (const fn of [
      "neo_reservation_deposit_position",
      "neo_reservation_deposit_record",
      "neo_checkin_deposit_override",
    ]) {
      expect(RPC_MANIFEST[fn]).toBe("authenticated");
    }
  });
});
