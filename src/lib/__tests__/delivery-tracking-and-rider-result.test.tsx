// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useRiderAdvance } from "@/lib/delivery-data";
import { usePublicOrderByReference } from "@/lib/public-delivery";

const transport = vi.hoisted(() => ({
  rpc: vi.fn(),
  filter: vi.fn(),
  order: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      const query = {
        select: () => query,
        eq: (key: string, value: string) => { transport.filter(key, value); return query; },
        maybeSingle: transport.order,
      };
      return query;
    },
  },
}));
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: transport.rpc }));
vi.mock("@/lib/preview-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/preview-mode")>(),
  guardPreview: () => undefined,
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

it("refreshes an active order and does not reuse its cached record for a different account", async () => {
  transport.order.mockResolvedValueOnce({ data: { order_status: "pending-payment" }, error: null });
  const { result, rerender } = renderHook(
    ({ userId }) => usePublicOrderByReference("hotel", "ORDER-1", "property", userId),
    { wrapper: queryWrapper(), initialProps: { userId: "guest-one" } },
  );
  await waitFor(() => expect(result.current.data?.["order_status"]).toBe("pending-payment"));
  expect(transport.filter.mock.calls).toEqual([
    ["organization_id", "hotel"], ["order_number", "ORDER-1"], ["branch_id", "property"],
  ]);

  transport.order.mockResolvedValueOnce({ data: { order_status: "confirmed" }, error: null });
  await waitFor(() => expect(result.current.data?.["order_status"]).toBe("confirmed"), { timeout: 6500 });

  transport.order.mockResolvedValueOnce({ data: null, error: null });
  rerender({ userId: "guest-two" });
  expect(result.current.data).toBeUndefined();
  await waitFor(() => expect(result.current.data).toBeNull());
}, 9000);

it("requires an affirmative Rider transition response and accepts an idempotent acknowledgement", async () => {
  transport.rpc.mockResolvedValueOnce({ data: { ok: false, detail: "Pickup was rejected" }, error: null });
  transport.rpc.mockResolvedValueOnce({ data: { ok: true, unchanged: true }, error: null });
  const { result } = renderHook(useRiderAdvance, { wrapper: queryWrapper() });
  const action = { orderId: "delivery-1", to: "collected" };

  await act(async () => {
    await expect(result.current.mutateAsync(action)).rejects.toThrow("Pickup was rejected");
  });
  expect(transport.rpc).toHaveBeenCalledWith(expect.anything(), "delivery_rider_advance", {
    _order: "delivery-1", _to: "collected",
  });
  await act(async () => {
    await expect(result.current.mutateAsync(action)).resolves.toBeUndefined();
  });
});
