// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApprovedReceivingPosting } from "@/components/inventory/ApprovedReceivingPosting";

const state = vi.hoisted(() => ({ branch: "property-a" as string | null, allowed: true, rpc: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => state.allowed, permissionsLoaded: true, organizationId: "org", user: { id: "reviewer" } }) }));
vi.mock("@/lib/branch-filter", () => ({ useActivePropertyFilter: () => ({ branchId: state.branch, filterKey: state.branch ?? "all" }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: (...args: unknown[]) => state.rpc(...args) }));
vi.mock("@/lib/supply-view-refresh", () => ({ invalidateSupplyViews: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ params, children }: any) => <a href={`/lpos/${params.id}`}>{children}</a> }));
vi.mock("@/components/common/DocumentPrintButton", () => ({ DocumentPrintButton: ({ id }: any) => <button data-grn={id}>Print GRN</button> }));
const countId = "b6000000-0000-4000-8000-000000000050";
const grnId = "b6000000-0000-4000-8000-000000000060";
const rows = [
  { count_id: countId, purchase_order_id: "purchase-a", branch_id: "property-a", order_number: "LPO-A", delivery_note: "DN-A", reviewed_at: "2026-11-16", line_count: 1 },
  { count_id: "count-b", purchase_order_id: "purchase-b", branch_id: "property-b", order_number: "LPO-B", delivery_note: "DN-B", reviewed_at: "2026-11-16", line_count: 1 },
];
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><ApprovedReceivingPosting /></QueryClientProvider>);
}
beforeEach(() => {
  state.branch = "property-a";
  state.allowed = true;
  state.rpc.mockReset();
  state.rpc.mockImplementation(async (_db, name) => ({ data: name === "neo_blind_receiving_approved_queue" ? rows : { ok: true, count_id: countId, status: "posted", grn_id: grnId, replayed: true }, error: null }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); vi.restoreAllMocks(); });
describe("receiving manager GRN handoff", () => {
  it("narrows approved counts to the selected property", async () => {
    mount();
    await screen.findByText("LPO-A");
    expect(screen.queryByText("LPO-B")).toBeNull();
  });
  it("offers the saved GRN and original purchase history after posting or replay", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Post Approved GRN" }));
    const print = await screen.findByRole("button", { name: "Print GRN" });
    expect(print.getAttribute("data-grn")).toBe(grnId);
    expect(screen.getByRole("link", { name: "Open purchase and document history" }).getAttribute("href")).toBe("/lpos/purchase-a");
    expect(state.rpc).toHaveBeenCalledWith({}, "neo_post_approved_blind_receiving", { _count_id: countId });
  });
  it("does not show saved GRN actions for a failed posting", async () => {
    state.rpc.mockImplementation(async (_db, name) => ({ data: name === "neo_blind_receiving_approved_queue" ? rows : { ok: false }, error: null }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Post Approved GRN" }));
    await waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Print GRN" })).toBeNull();
  });
  it("does not post when confirmation is cancelled", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Post Approved GRN" }));
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });
  it("reports an older queue contract instead of silently hiding or posting its counts", async () => {
    state.rpc.mockResolvedValue({ data: [{ count_id: countId, order_number: "LPO-OLD" }], error: null });
    mount();
    await screen.findByText(/receiving queue needs the property and purchase history update/);
    expect(screen.queryByRole("button", { name: "Post Approved GRN" })).toBeNull();
  });
  it("hides a saved GRN when switching to another property", async () => {
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Post Approved GRN" }));
    await screen.findByRole("button", { name: "Print GRN" });
    state.branch = "property-b";
    // Re-render through the same query provider so the component retains its saved result.
    view.rerender(<QueryClientProvider client={clients[0]!}><ApprovedReceivingPosting /></QueryClientProvider>);
    await screen.findByText("LPO-B");
    expect(screen.queryByRole("button", { name: "Print GRN" })).toBeNull();
  });
  it("does not fetch or offer posting without receiving authority", () => {
    state.allowed = false;
    mount();
    expect(state.rpc).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
