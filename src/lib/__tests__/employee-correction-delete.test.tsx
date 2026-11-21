// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeleteIncorrectEmployeeButton } from "@/components/hr/DeleteIncorrectEmployeeButton";
const m = vi.hoisted(() => ({ rpc: vi.fn(), navigate: vi.fn(), allowed: true }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ isAdmin: false, can: () => m.allowed }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => m.navigate }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: (...args: unknown[]) => m.rpc(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => {
  m.allowed = true;
  m.rpc.mockReset();
  m.navigate.mockReset();
});
function mount(linkedProfile = false) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DeleteIncorrectEmployeeButton
        id="employee-1"
        number="EMP-WRONG"
        name="Wrong Person"
        linkedProfile={linkedProfile}
      />
    </QueryClientProvider>,
  );
}
function open() {
  fireEvent.click(screen.getByText("Delete incorrect record"));
}
function confirm() {
  fireEvent.change(screen.getByLabelText("Type EMP-WRONG to confirm"), {
    target: { value: "EMP-WRONG" },
  });
  fireEvent.change(screen.getByLabelText("Why is this record incorrect?"), {
    target: { value: "Duplicate entered by mistake" },
  });
}
describe("employee correction deletion", () => {
  it("requires existing delete authority", () => {
    m.allowed = false;
    mount();
    expect(screen.queryByText("Delete incorrect record")).toBeNull();
  });
  it("requires typed record number and reason", () => {
    mount();
    open();
    expect((screen.getByText("Delete this incorrect record") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("does not offer deletion for a linked login", () => {
    mount(true);
    open();
    confirm();
    expect((screen.getByText("Delete this incorrect record") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("preserves the confirmation and reason when history blocks deletion", async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { message: "Payroll history prevents deletion" },
    });
    mount();
    open();
    confirm();
    fireEvent.click(screen.getByText("Delete this incorrect record"));
    await screen.findByText("Payroll history prevents deletion");
    expect((screen.getByLabelText("Why is this record incorrect?") as HTMLInputElement).value).toBe(
      "Duplicate entered by mistake",
    );
    expect(m.navigate).not.toHaveBeenCalled();
  });
  it("requires verified saved deletion before navigating", async () => {
    m.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    mount();
    open();
    confirm();
    fireEvent.click(screen.getByText("Delete this incorrect record"));
    await screen.findByRole("alert");
    expect(m.navigate).not.toHaveBeenCalled();
  });
  it("navigates only after the exact employee deletion is confirmed", async () => {
    m.rpc.mockResolvedValue({
      data: { ok: true, deleted: true, employee_id: "employee-1", linked_login_deleted: false },
      error: null,
    });
    mount();
    open();
    confirm();
    fireEvent.click(screen.getByText("Delete this incorrect record"));
    await waitFor(() => expect(m.navigate).toHaveBeenCalledWith({ to: "/hr/employees" }));
    expect(m.rpc.mock.calls[0]?.[2]).toEqual({
      _employee: "employee-1",
      _confirmation: "EMP-WRONG",
      _reason: "Duplicate entered by mistake",
    });
  });
});
