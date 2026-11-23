// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: rpc.call }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ organizationId: "test-org" }) }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

import { useRefreshBillTotalsOnOpen } from "@/lib/pos-data";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function setup() {
  const client = new QueryClient();
  client.setQueryData(["pos", "order", "test-org", "all", "bill-1"], { grand_total: 1699.5 });
  client.setQueryData(["pos", "orders", "test-org"], []);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

describe("reopening a till bill", () => {
  it("asks the database to recalculate the bill's totals from its items, once", async () => {
    rpc.call.mockResolvedValue({ data: { refreshed: true, previous_total: 1699.5, grand_total: 1650 }, error: null });
    const { client, wrapper } = setup();
    const { rerender } = renderHook(() => useRefreshBillTotalsOnOpen("bill-1"), { wrapper });
    rerender();
    await waitFor(() => expect(client.getQueryState(["pos", "orders", "test-org"])?.isInvalidated).toBe(true));
    expect(rpc.call).toHaveBeenCalledTimes(1);
    expect(rpc.call).toHaveBeenCalledWith(expect.anything(), "neo_pos_refresh_bill_totals", { _order: "bill-1" });
    expect(client.getQueryState(["pos", "order", "test-org", "all", "bill-1"])?.isInvalidated).toBe(true);
    client.clear();
  });

  it("leaves the shown bill alone when its stored total was already right", async () => {
    rpc.call.mockResolvedValue({ data: { refreshed: false, reason: "unchanged", grand_total: 1650 }, error: null });
    const { client, wrapper } = setup();
    renderHook(() => useRefreshBillTotalsOnOpen("bill-1"), { wrapper });
    await waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(1));
    expect(client.getQueryState(["pos", "order", "test-org", "all", "bill-1"])?.isInvalidated).toBe(false);
    client.clear();
  });
});
