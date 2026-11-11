// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RecordElectronicRefundButton } from "@/components/finance/RecordElectronicRefundButton";
const state = vi.hoisted(() => ({ allowed: true, pending: false, save: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ isAdmin: false, can: () => state.allowed }) }));
vi.mock("@/lib/pos-refunds", () => ({
  useRecordElectronicRefund: () => ({ isPending: state.pending, mutateAsync: state.save }),
}));
vi.mock("@/components/payments/ReceivingAccountSelect", () => ({
  ReceivingAccountSelect: () => null,
}));
afterEach(cleanup);
beforeEach(() => {
  state.allowed = true;
  state.pending = false;
  state.save.mockReset();
});
function open() {
  render(<RecordElectronicRefundButton requestId="r" branchId="b" originalAccountId="bank" />);
  fireEvent.click(screen.getByRole("button", { name: "Record completed electronic refund" }));
}
describe("electronic refund form", () => {
  it("withholds controls without authority", () => {
    state.allowed = false;
    render(<RecordElectronicRefundButton requestId="r" branchId="b" originalAccountId="bank" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("requires reference and explicit completion", () => {
    open();
    const button = screen.getByRole("button", {
      name: "Record verified refund",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Bank/provider refund confirmation reference"), {
      target: { value: "REF-ONE" },
    });
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(button.disabled).toBe(false);
  });
  it("retains entered evidence on failure", async () => {
    state.save.mockRejectedValue(new Error("Posting period closed"));
    open();
    fireEvent.change(screen.getByLabelText("Bank/provider refund confirmation reference"), {
      target: { value: "REF-ONE" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Record verified refund" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Posting period closed"),
    );
    expect(
      (screen.getByLabelText("Bank/provider refund confirmation reference") as HTMLInputElement)
        .value,
    ).toBe("REF-ONE");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(state.save).toHaveBeenCalledWith({
      requestId: "r",
      reference: "REF-ONE",
      accountId: "bank",
      completed: true,
    });
  });
  it("closes after saving", async () => {
    state.save.mockResolvedValue({ ok: true });
    open();
    fireEvent.change(screen.getByLabelText("Bank/provider refund confirmation reference"), {
      target: { value: "REF-ONE" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Record verified refund" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
