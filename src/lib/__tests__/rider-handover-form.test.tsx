// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RiderHandoverForm } from "@/components/public/RiderHandoverForm";

const state = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, isSuccess: false, isError: false, error: null as Error | null }));
vi.mock("@/lib/delivery-data", () => ({ useConfirmDelivery: () => state }));
afterEach(() => {
  cleanup();
  state.mutate.mockReset();
  state.isPending = state.isSuccess = state.isError = false;
  state.error = null;
});

it("sends the current order PIN, recipient and valid cash without accepting invalid cash", () => {
  render(<RiderHandoverForm orderId="cash-order" paymentMethod="cash-on-delivery" />);
  fireEvent.change(screen.getByLabelText("Customer PIN"), { target: { value: "012345" } });
  fireEvent.change(screen.getByLabelText("Received by"), { target: { value: " Amina " } });
  const cash = screen.getByLabelText("Cash collected");
  const confirm = screen.getByRole("button", { name: "Confirm delivery" });
  fireEvent.change(cash, { target: { value: "-1" } });
  fireEvent.click(confirm);
  expect(state.mutate).not.toHaveBeenCalled();
  fireEvent.change(cash, { target: { value: "100.50" } });
  fireEvent.click(confirm);
  expect(state.mutate).toHaveBeenCalledWith({ orderId: "cash-order", pin: "012345", recipient: "Amina", cash: 100.5 });
});

it("omits cash for non-cash orders and leaves an RPC rejection visible on the handover", () => {
  state.isError = true;
  state.error = new Error("Incorrect PIN. Try again.");
  render(<RiderHandoverForm orderId="prepaid-order" paymentMethod="mpesa" />);
  expect(screen.queryByLabelText("Cash collected")).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe("Incorrect PIN. Try again.");
  fireEvent.change(screen.getByLabelText("Received by"), { target: { value: "Amina" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm delivery" }));
  expect(state.mutate).toHaveBeenCalledWith({ orderId: "prepaid-order", pin: "", recipient: "Amina" });
});
