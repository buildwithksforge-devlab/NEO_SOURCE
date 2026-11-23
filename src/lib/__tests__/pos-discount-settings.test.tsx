// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PosDiscountSettings } from "@/components/pos/PosDiscountSettings";

const mock = vi.hoisted(() => ({ insert: vi.fn(), branch: "mombasa" as string | null }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ organizationId: "hotel" }) }));
vi.mock("@/lib/branch-filter", () => ({ useActivePropertyFilter: () => ({ branchId: mock.branch }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      const read = { eq: () => read, order: async () => ({ data: [], error: null }) };
      return {
        select: () => read,
        insert: (row: unknown) => {
          mock.insert(row);
          return { select: () => ({ single: async () => ({ data: { id: "discount" }, error: null }) }) };
        },
      };
    },
  },
}));

const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
afterEach(() => {
  cleanup();
  client.clear();
  mock.insert.mockClear();
  mock.branch = "mombasa";
});

function openSettings() {
  render(<QueryClientProvider client={client}><PosDiscountSettings /></QueryClientProvider>);
}

it("saves a property discount with its approval requirement and selected order types", async () => {
  openSettings();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Lunch" } });
  fireEvent.change(screen.getByLabelText("Discount value"), { target: { value: "101" } });
  expect((screen.getByRole("button", { name: "Add discount" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Discount value"), { target: { value: "10" } });
  fireEvent.change(screen.getByLabelText("Maximum discount amount (optional)"), { target: { value: "500" } });
  fireEvent.click(screen.getByLabelText("dine in"));
  fireEvent.click(screen.getByRole("button", { name: "Add discount" }));
  await waitFor(() => expect(mock.insert).toHaveBeenCalledWith(expect.objectContaining({
    organization_id: "hotel", branch_id: "mombasa", name: "Lunch", discount_type: "percentage",
    value: 10, max_value: 500, order_types: ["dine-in"], active: true, requires_approval: true,
  })));
});

it("requires an explicitly selected property before showing write controls", () => {
  mock.branch = null;
  openSettings();
  expect(screen.queryByRole("button", { name: "Add discount" })).toBeNull();
  expect(mock.insert).not.toHaveBeenCalled();
});
