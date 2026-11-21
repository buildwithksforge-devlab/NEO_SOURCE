import { describe, expect, it } from "vitest";
import { requireGuestOrderResult } from "@/lib/guest-order-result";
const saved = { delivery_order_id: "10000000-0000-4000-8000-000000000001",
  pos_order_id: "20000000-0000-4000-8000-000000000001", order_number: "TEST-ORDER" };
describe("guest order confirmation evidence", () => {
  it.each([null, {}, [], { order_number: "TEST" }, { ...saved, pos_order_id: "null" },
    { ...saved, delivery_order_id: "not-an-id" }])("refuses incomplete durable confirmation: %j", (result) => {
    expect(() => requireGuestOrderResult(result)).toThrow();
  });
  it("rejects explicit business refusal even when IDs are supplied", () => {
    expect(() => requireGuestOrderResult({ ...saved, ok: false, reason: "Not permitted" })).toThrow("Not permitted");
  });
  it("retains a confirmed delivery and a null handoff PIN on replay", () => {
    expect(requireGuestOrderResult({ ...saved, pin: null, duplicate_suppressed: true })).toMatchObject(saved);
  });
  it("does not claim room settlement without its first saved folio line", () => {
    expect(() => requireGuestOrderResult({ ...saved, charged_to_room: true }, true)).toThrow(/room-bill/);
    expect(requireGuestOrderResult({ ...saved, charged_to_room: true,
      folio_line_id: "30000000-0000-4000-8000-000000000001" }, true)).toMatchObject(saved);
  });
  it("keeps the existing duplicate room-charge result valid without charging again", () => {
    expect(requireGuestOrderResult({ ...saved, charged_to_room: true,
      duplicate_suppressed: true, folio_line_id: null }, true)).toMatchObject(saved);
  });
  it("requires the requested settlement option to match the response", () => {
    expect(() => requireGuestOrderResult({ ...saved, charged_to_room: false }, true)).toThrow(/settlement option/);
    expect(requireGuestOrderResult({ ...saved, charged_to_room: false }, false)).toMatchObject(saved);
  });
});
