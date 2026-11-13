// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";

const mock = vi.hoisted(() => ({
  record: vi.fn(),
  cash: vi.fn(),
  charge: vi.fn(),
  reconcile: vi.fn(),
  openIntent: vi.fn(),
  dispatch: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  readiness: {
    isError: false,
    isPending: false,
    data: [
      { method: "mpesa", ready: true },
      { method: "card-terminal", ready: true },
      { method: "qr", ready: true },
    ],
  },
  mpesa: {
    isError: false,
    isPending: false,
    data: { ready: true, configured: true, enabled: true },
  },
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock("@/lib/cash-routing", () => ({
  useRequestPosCashPayment: () => ({ mutate: mock.cash, isPending: false }),
  useTillContext: () => ({ data: { self_service: true }, isLoading: false, isError: false }),
}));
vi.mock("@/lib/pos-data", () => ({
  useRecordPayment: () => ({ mutate: mock.record, isPending: false }),
}));
vi.mock("@/lib/payment-intents", () => ({
  useOpenPaymentIntent: () => ({ mutate: mock.openIntent }),
  useDispatchPaymentIntent: () => ({ mutate: mock.dispatch }),
  usePaymentIntentStatus: () => ({ data: undefined }),
}));
vi.mock("@/lib/payment-methods", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payment-methods")>()),
  usePaymentReadiness: () => mock.readiness,
  useMpesaCollectionStatus: () => mock.mpesa,
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("@/lib/mpesa.functions", () => ({
  chargeWithMpesa: mock.charge,
  reconcileMpesaTransaction: mock.reconcile,
}));
vi.mock("sonner", () => ({
  toast: { success: mock.success, warning: mock.warning, info: mock.info, error: mock.error },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { id: "txn", status: "pending" }, error: null }),
        }),
      }),
    }),
  },
}));
vi.mock("@/components/payments/ReceivingAccountSelect", () => ({
  ReceivingAccountSelect: () => null,
}));
vi.mock("@/components/payments/QrPaymentPanel", () => ({ QrPaymentPanel: () => null }));
// Keep the real method picker and forms; replace only the third-party select
// primitive with native controls so tests can exercise disabled/missing states.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select
      aria-label="Payment method"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: (props: ComponentProps<"option">) => <option {...props} />,
}));

import { PaymentDialog } from "@/components/pos/PosPaymentDialog";
import { MpesaPromptDialog } from "@/components/payments/MpesaPromptDialog";
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mock.readiness.isError = false;
  mock.readiness.isPending = false;
  mock.readiness.data = [
    { method: "mpesa", ready: true },
    { method: "card-terminal", ready: true },
    { method: "qr", ready: true },
  ];
  mock.mpesa.isError = false;
  mock.mpesa.isPending = false;
  mock.mpesa.data = { ready: true, configured: true, enabled: true };
  mock.charge.mockResolvedValue({
    ok: true,
    status: "pending",
    transactionId: "txn",
    detail: "Accepted by Safaricom",
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
});
function mount(
  children = (
    <PaymentDialog
      open
      onOpenChange={vi.fn()}
      orderId="order-1"
      branchId="property-1"
      balance={100}
      shiftId="shift"
    />
  ),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  clients.push(client);
  return {
    ...render(<QueryClientProvider client={client}>{children}</QueryClientProvider>),
    client,
  };
}
const choose = (method: string) =>
  fireEvent.change(screen.getByRole("combobox", { name: "Payment method" }), {
    target: { value: method },
  });
const phone = () =>
  fireEvent.change(screen.getByLabelText("Customer phone"), { target: { value: "0712345678" } });

describe("POS payment entry dispatch and readiness", () => {
  it("submits only one terminal attempt for rapid clicks and preserves the property's context", () => {
    mount();
    choose("card-terminal");
    const submit = screen.getByRole("button", { name: "Send to terminal" });
    act(() => {
      submit.click();
      submit.click();
    });
    expect(mock.record).toHaveBeenCalledOnce();
    act(() => mock.record.mock.calls[0]![1].onSuccess({ payment_id: "payment-1" }));
    expect(mock.openIntent).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: "property-1", linkId: "payment-1" }),
      expect.any(Object),
    );
    fireEvent.click(submit);
    expect(mock.record).toHaveBeenCalledOnce();
    choose("bank-transfer");
    expect(
      (screen.getByRole("combobox", { name: "Payment method" }) as HTMLSelectElement).value,
    ).toBe("card-terminal");
  });

  it("keeps an unsuccessfully opened QR attempt locked instead of recording another payment", () => {
    mount();
    choose("qr");
    fireEvent.click(screen.getByRole("button", { name: "Send to terminal" }));
    act(() => mock.record.mock.calls[0]![1].onSuccess({ payment_id: "payment-1" }));
    act(() => mock.openIntent.mock.calls[0]![1].onSuccess({ ok: false, detail: "Not connected" }));
    expect(screen.getByText("Not connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send to terminal" }));
    expect(mock.record).toHaveBeenCalledOnce();
    expect(mock.dispatch).not.toHaveBeenCalled();
  });

  it("retains a possibly recorded terminal attempt when its response is lost", () => {
    mount();
    choose("card-terminal");
    fireEvent.click(screen.getByRole("button", { name: "Send to terminal" }));
    act(() => mock.record.mock.calls[0]![1].onError(new Error("Connection lost")));
    expect(screen.getByText(/Connection lost.*may have been recorded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send to terminal" }));
    expect(mock.record).toHaveBeenCalledOnce();
  });

  it("does not dispatch or allow a second terminal payment when the record response has no ID", () => {
    mount();
    choose("card-terminal");
    fireEvent.click(screen.getByRole("button", { name: "Send to terminal" }));
    act(() => mock.record.mock.calls[0]![1].onSuccess({}));
    expect(screen.getByText(/payment response has no tracking ID/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send to terminal" }));
    expect(mock.record).toHaveBeenCalledOnce();
    expect(mock.openIntent).not.toHaveBeenCalled();
  });

  it("sends only one M-Pesa request for clicks before mutation state renders", async () => {
    mock.charge.mockImplementationOnce(() => new Promise(() => {}));
    mount();
    choose("mpesa");
    phone();
    const submit = screen.getByRole("button", { name: "Send prompt" });
    act(() => {
      submit.click();
      submit.click();
    });
    await waitFor(() => expect(mock.charge).toHaveBeenCalledOnce());
    expect((screen.getByLabelText("Customer phone") as HTMLInputElement).disabled).toBe(true);
  });

  it("keeps bank-transfer recording independent of provider readiness", () => {
    mock.readiness.isError = true;
    mock.readiness.data = [];
    mount();
    choose("bank-transfer");
    fireEvent.change(screen.getByLabelText("Reference"), { target: { value: "BANK-EVIDENCE-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
    expect(mock.record).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "bank-transfer",
        amount: 100,
        externalReference: "BANK-EVIDENCE-1",
      }),
      expect.any(Object),
    );
    expect(mock.charge).not.toHaveBeenCalled();
    expect(mock.openIntent).not.toHaveBeenCalled();
  });

  it("records a standalone bank terminal slip without dispatching another electronic charge", () => {
    mock.readiness.isError = true;
    mock.readiness.data = [];
    mount();
    choose("card");
    fireEvent.change(screen.getByLabelText("Approval / terminal reference"), {
      target: { value: "APPROVAL-1" },
    });
    fireEvent.change(screen.getByLabelText("Terminal"), { target: { value: "Bank POS" } });
    fireEvent.change(screen.getAllByRole("combobox")[1]!, { target: { value: "Visa" } });
    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
    expect(mock.record).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "card",
        paymentMetadata: { terminal: "Bank POS", network: "Visa" },
      }),
      expect.any(Object),
    );
    expect(mock.charge).not.toHaveBeenCalled();
    expect(mock.dispatch).not.toHaveBeenCalled();
  });

  it("does not bypass unavailable-provider gating through the manual-confirm toggle", () => {
    mock.readiness.data = [];
    mount();
    choose("qr");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Confirm verified external receipt manually" }),
    );
    fireEvent.change(screen.getByLabelText("Verification note"), {
      target: { value: "A note is not provider connectivity" },
    });
    const submit = screen.getByRole("button", { name: "Record & confirm" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(mock.record).not.toHaveBeenCalled();
    expect(mock.dispatch).not.toHaveBeenCalled();
  });

  it("blocks an already selected M-Pesa form if shared readiness subsequently fails", () => {
    const view = mount();
    choose("mpesa");
    phone();
    mock.readiness.isError = true;
    view.rerender(
      <QueryClientProvider client={view.client}>
        <PaymentDialog
          open
          onOpenChange={vi.fn()}
          orderId="order-1"
          branchId="property-1"
          balance={100}
          shiftId="shift"
        />
      </QueryClientProvider>,
    );
    expect(
      (screen.getByRole("button", { name: "Send prompt" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    expect(mock.charge).not.toHaveBeenCalled();
    expect(mock.record).not.toHaveBeenCalled();
  });
  it("sends M-Pesa through the actual prompt handler, carrying the entered amount, without recording a separate payment", async () => {
    mount();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "25" } });
    choose("mpesa");
    phone();
    expect(screen.getByRole("heading", { name: "Charge to M-Pesa" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await waitFor(() => expect(mock.charge).toHaveBeenCalledOnce());
    expect(mock.charge).toHaveBeenCalledWith({
      data: {
        sourceModule: "pos_order",
        sourceRecordId: "order-1",
        msisdn: "0712345678",
        amount: 25,
        description: null,
      },
    });
    expect(mock.record).not.toHaveBeenCalled();
    expect(mock.openIntent).not.toHaveBeenCalled();
    expect(mock.cash).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send prompt" })).toBeNull());
    expect(mock.success.mock.calls.flat().join(" ")).not.toContain("payment received");
  });

  it("does not fall back to recording a pending payment when prompt dispatch rejects", async () => {
    mock.charge.mockRejectedValue(new Error("Backend is unavailable"));
    mount();
    choose("mpesa");
    phone();
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await waitFor(() => expect(mock.error).toHaveBeenCalledWith("Backend is unavailable"));
    expect(mock.record).not.toHaveBeenCalled();
    expect(mock.openIntent).not.toHaveBeenCalled();
  });

  it("blocks provider options and submission while readiness is loading, including a forced retained selection", () => {
    mock.readiness.isPending = true;
    mock.readiness.data = [];
    mount();
    expect(
      (screen.getByRole("option", { name: /M-Pesa.*checking/ }) as HTMLOptionElement).disabled,
    ).toBe(true);
    choose("mpesa");
    phone();
    const send = screen.getByRole("button", { name: "Send prompt" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(mock.charge).not.toHaveBeenCalled();
    expect(mock.record).not.toHaveBeenCalled();
  });

  it("blocks a cached-ready terminal on readiness error without blocking cash", () => {
    mock.readiness.isError = true;
    mount();
    expect(
      (screen.getByRole("button", { name: "Confirm cash received" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    choose("card-terminal");
    const send = screen.getByRole("button", { name: "Send to terminal" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(mock.record).not.toHaveBeenCalled();
    expect(mock.openIntent).not.toHaveBeenCalled();
  });

  it("does not accept an absent provider row as ready", () => {
    mock.readiness.data = [];
    mount();
    expect(
      (screen.getByRole("option", { name: /QR payment.*unavailable/ }) as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    choose("qr");
    fireEvent.click(screen.getByRole("button", { name: "Send to terminal" }));
    expect(mock.record).not.toHaveBeenCalled();
    expect(mock.dispatch).not.toHaveBeenCalled();
  });

  it("keeps cash routing independent of provider setup", () => {
    mock.readiness.isPending = true;
    mock.readiness.data = [];
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Confirm cash received" }));
    expect(mock.cash).toHaveBeenCalledOnce();
    expect(mock.record).not.toHaveBeenCalled();
    expect(mock.charge).not.toHaveBeenCalled();
  });

  it("does not silently round a fractional amount into an STK request", () => {
    mount();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "25.50" } });
    choose("mpesa");
    phone();
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("25.50");
    expect(
      (screen.getByRole("button", { name: "Send prompt" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mock.charge).not.toHaveBeenCalled();
  });

  it("withholds the standalone prompt action until its own readiness check succeeds", () => {
    mock.mpesa.isPending = true;
    mock.mpesa.data = { ready: false, configured: false, enabled: false };
    mount(<MpesaPromptDialog sourceModule="pos_order" sourceRecordId="order-1" balance={100} />);
    expect(
      (screen.getByRole("button", { name: /Checking M-Pesa/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Send prompt" })).toBeNull();
    expect(mock.charge).not.toHaveBeenCalled();
  });

  it("shows an unknown result as a warning and prevents a second prompt", async () => {
    mock.charge.mockResolvedValue({
      ok: true,
      status: "unknown",
      transactionId: "txn",
      detail: "Outcome uncertain; check this attempt.",
    });
    mount();
    choose("mpesa");
    phone();
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await waitFor(() =>
      expect(mock.warning).toHaveBeenCalledWith("Outcome uncertain; check this attempt."),
    );
    expect(mock.success).not.toHaveBeenCalled();
    expect(mock.record).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Send prompt" })).toBeNull();
  });
});
