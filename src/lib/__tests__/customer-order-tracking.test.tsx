// @vitest-environment jsdom
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCancelGuestOrder, useGuestOrderTracking } from "@/lib/guest-ordering";
import { useDeliveryLive } from "@/lib/delivery-live";
import { useMyOrderPin } from "@/lib/delivery-data";
import { submitDeliveryMpesaReference } from "@/lib/delivery-mpesa-reference";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: (...args: unknown[]) => rpc(...args) }));
vi.mock("@/lib/preview-mode", () => ({ guardPreview: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
afterEach(() => {
  cleanup();
  queryClient.clear();
  rpc.mockReset();
  vi.restoreAllMocks();
});

it("requires a saved Till claim and recovers its pending or verified status on retry", async () => {
  await expect(submitDeliveryMpesaReference("order-1", "bad")).rejects.toThrow(/valid M-PESA/);
  expect(rpc).not.toHaveBeenCalled();
  rpc.mockResolvedValueOnce({ data: { ok: true }, error: null });
  await expect(submitDeliveryMpesaReference("order-1", "abc-1234567")).rejects.toThrow(/was saved/);
  expect(rpc).toHaveBeenLastCalledWith({}, "neo_delivery_mpesa_till_claim_submit", { _order: "order-1", _receipt: "ABC1234567" });
  for (const status of ["submitted", "merchant_verified"]) {
    rpc.mockResolvedValueOnce({ data: { ok: true, claim_id: "claim-1", status }, error: null });
    await expect(submitDeliveryMpesaReference("order-1", "ABC1234567")).resolves.toBe(status);
  }
  rpc.mockResolvedValueOnce({ data: { ok: true, claim_id: "claim-1", status: "rejected" }, error: null });
  await expect(submitDeliveryMpesaReference("order-1", "ABC1234567")).rejects.toThrow(/Finance rejected/);
});

it("does not reuse the previous customer's order details, courier location or PIN while the next account loads", async () => {
  rpc.mockImplementation(async (_client, name: string) => ({
    data: name === "neo_guest_order_tracking" ? { id: "order-1" } : name === "neo_guest_delivery_live" ? { live: false } : { ok: true },
    error: null,
  }));
  const { result, rerender } = renderHook(({ userId }) => ({
    tracking: useGuestOrderTracking("org", "REF", "order-1", userId),
    live: useDeliveryLive("org", "REF", "order-1", userId),
    pin: useMyOrderPin("order-1", userId),
  }), { initialProps: { userId: "first" }, wrapper });
  await waitFor(() => expect(result.current.pin.data).toEqual({ ok: true }));
  expect(result.current.tracking.data?.id).toBe("order-1");
  expect(result.current.live.data).toEqual({ live: false });
  rpc.mockResolvedValue({ data: null, error: null });
  rerender({ userId: "second" });
  expect(result.current.tracking.data).toBeUndefined();
  expect(result.current.live.data).toBeUndefined();
  expect(result.current.pin.data).toBeUndefined();
  await waitFor(() => expect(result.current.pin.data).toBeNull());

  rpc.mockResolvedValue({ data: { id: "different-order" }, error: null });
  rerender({ userId: "third" });
  await waitFor(() => expect(result.current.tracking.isSuccess).toBe(true));
  expect(result.current.tracking.data).toBeNull();
});

it("refreshes the matching order and its list after cancellation or a refused stale request", async () => {
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const { result } = renderHook(() => useCancelGuestOrder("org", "REF"), { wrapper });
  rpc.mockResolvedValueOnce({ data: { ok: true, already_cancelled: true }, error: null });
  await act(async () => {
    await expect(result.current.mutateAsync({})).resolves.toMatchObject({ already_cancelled: true });
  });
  rpc.mockResolvedValueOnce({ data: { ok: false, reason: "already_started" }, error: null });
  await act(async () => {
    await expect(result.current.mutateAsync({})).rejects.toThrow(/already been started or paid/);
  });
  expect(invalidate.mock.calls.map(([filter]) => filter?.queryKey)).toEqual([
    ["guest-tracking", "org", "REF"], ["public-delivery", "org", "track", "REF"], ["public-delivery", "org", "orders"],
    ["guest-tracking", "org", "REF"], ["public-delivery", "org", "track", "REF"], ["public-delivery", "org", "orders"],
  ]);
});
