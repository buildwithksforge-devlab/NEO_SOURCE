import { describe, expect, it, vi } from "vitest";
import { resolveApprovedCountOwnership, resolveTransferActionResult } from "@/lib/supply-release-compat";
const id = "00000000-0000-4000-8000-000000000001";
describe("safe application rollout against older supply RPC responses", () => {
  it("uses saved count ownership when legacy queue metadata is omitted", async () => {
    const load = vi.fn(async () => [{ id, branch_id: "hotel-a", purchase_order_id: "purchase-a" }]);
    expect(await resolveApprovedCountOwnership([{ count_id: id, order_number: "LPO-1" }], load))
      .toEqual([{ count_id: id, order_number: "LPO-1", branch_id: "hotel-a", purchase_order_id: "purchase-a" }]);
    expect(load).toHaveBeenCalledWith([id]);
  });
  it("does not read legacy fallback data for complete modern responses", async () => {
    const load = vi.fn();
    const value = [{ count_id: id, branch_id: "hotel-a", purchase_order_id: "purchase-a" }];
    expect(await resolveApprovedCountOwnership(value, load)).toEqual(value);
    expect(load).not.toHaveBeenCalled();
  });
  it.each([{ saved: [] }, { saved: [{ id, branch_id: "hotel-b", purchase_order_id: "purchase-a" }] }])("refuses missing or conflicting count ownership %j", async ({ saved }) => {
    await expect(resolveApprovedCountOwnership([{ count_id: id, branch_id: "hotel-a" }], async () => saved)).rejects.toThrow(/receiving queue needs/);
  });
  it.each(["receive", "cancel"] as const)("verifies the saved identity/state for legacy %s", async (action) => {
    const status = action === "receive" ? "completed" : "cancelled";
    expect(await resolveTransferActionResult({ ok: true, status }, action, id, async () => ({ id, status })))
      .toEqual({ ok: true, status, transfer_id: id });
  });
  it.each([null, { id: "other", status: "completed" }, { id, status: "in-transit" }])("refuses legacy success without matching saved transfer %j", async (saved) => {
    await expect(resolveTransferActionResult({ ok: true, status: "completed" }, "receive", id, async () => saved)).rejects.toThrow(/not verified/);
  });
  it("never turns a business failure or conflicting explicit ID into success", async () => {
    const load = vi.fn(async () => ({ id, status: "completed" }));
    await expect(resolveTransferActionResult({ ok: false, status: "completed" }, "receive", id, load)).rejects.toThrow();
    await expect(resolveTransferActionResult({ ok: true, transfer_id: "other", status: "completed" }, "receive", id, load)).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
  });
});
