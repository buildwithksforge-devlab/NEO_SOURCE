import { describe, it, expect } from "vitest";
import { reservationCollections, type CollectionSource } from "@/lib/reservation-collections";
import { depositIdempotencyKey } from "@/lib/deposits";
const payment: CollectionSource = {
  id: "p",
  amount: 5000,
  currency: "KES",
  method: "cash",
  status: "confirmed",
};
const deposit: CollectionSource = { ...payment, id: "d", status: "held" };
describe("reservation collection evidence", () => {
  it("shows pre-arrival deposits without a folio payment", () =>
    expect(reservationCollections([deposit], [])[0]).toMatchObject({
      kind: "deposit",
      state: "Received",
      amount: 5000,
    }));
  it("deduplicates the same payment fetched by reservation and folio", () =>
    expect(reservationCollections([], [payment, payment])).toHaveLength(1));
  it("deposit application and linked receipt are one collection", () =>
    expect(
      reservationCollections([{ ...deposit, status: "applied", payment_id: "p" }], [payment]),
    ).toHaveLength(1));
  it("retains genuine equal-amount installments", () =>
    expect(reservationCollections([deposit, { ...deposit, id: "d2" }], [payment])).toHaveLength(3));
  it("pending tender is not shown as received", () =>
    expect(reservationCollections([], [{ ...payment, status: "pending" }])[0]?.state).toBe(
      "Awaiting confirmation",
    ));
  it("refunded receipt is explicit", () =>
    expect(reservationCollections([], [{ ...payment, status: "refunded" }])[0]?.state).toBe(
      "Refunded",
    ));
  it("rejects disagreement between linked evidence", () =>
    expect(() =>
      reservationCollections([{ ...deposit, payment_id: "p" }], [{ ...payment, amount: 6000 }]),
    ).toThrow(/disagree/));
  it("rejects conflicting repeated payment snapshots", () =>
    expect(() => reservationCollections([], [payment, { ...payment, currency: "USD" }])).toThrow(
      /disagrees/,
    ));
  it("rejects nonfinite collection evidence", () =>
    expect(() => reservationCollections([], [{ ...payment, amount: "NaN" }])).toThrow(/verified/));
  const intent = {
    reservationId: "r",
    propertyId: "b",
    amount: 5000,
    method: "cash",
    intentKey: "one",
  };
  it("keeps the collection key on changed-detail retries for server validation", () =>
    expect(depositIdempotencyKey(intent)).toBe(depositIdempotencyKey({ ...intent, amount: 6000 })));
  it("genuine equal deposits have distinct intent keys", () =>
    expect(depositIdempotencyKey(intent)).not.toBe(
      depositIdempotencyKey({ ...intent, intentKey: "two" }),
    ));
});

