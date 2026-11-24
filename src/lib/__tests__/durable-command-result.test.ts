import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  requireAccrualResult,
  requirePrintJobId,
  requireSavedRecord,
  requirePosPaymentResult,
  requireMpesaReceiptReviewResult,
} from "@/lib/durable-command-result";

describe("saved payment responses", () => {
  const paymentId = "ab000000-0000-4000-8000-000000000001";
  it("accepts a saved pending attempt without treating it as confirmation", () => {
    expect(requirePosPaymentResult({ payment_id: paymentId, status: "pending" })["status"]).toBe("pending");
    expect(() => requirePosPaymentResult({ payment_id: paymentId, status: "pending" }, { confirmed: true })).toThrow("Check the existing attempt");
  });
  it("requires confirmation for the exact requested payment", () => {
    expect(requirePosPaymentResult({ payment_id: paymentId, status: "confirmed" }, { paymentId, confirmed: true })["payment_id"]).toBe(paymentId);
    expect(() => requirePosPaymentResult({ payment_id: "ab000000-0000-4000-8000-000000000002", status: "confirmed" }, { paymentId, confirmed: true })).toThrow("No saved payment");
  });
  it.each([null, {}, { status: "confirmed" }, { payment_id: "saved", status: "confirmed" }, { payment_id: paymentId, status: "failed" }])("refuses an unproven saved result %j", (value) => {
    expect(() => requirePosPaymentResult(value)).toThrow("No saved payment");
  });
  it("preserves the backend refusal instead of reporting success", () => {
    expect(() => requirePosPaymentResult({ ok: false, detail: "Provider receipt is still pending" })).toThrow("Provider receipt is still pending");
  });
});
import { useQueuePrint, useRecordPrintResult, useRetryPrintJob } from "@/lib/printing";

const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
  warning: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: mock.rpc }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({
  toast: { success: mock.success, error: mock.error, message: mock.message, warning: mock.warning },
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: unknown) => options,
  useQuery: vi.fn(),
  useQueryClient: () => ({ invalidateQueries: mock.invalidate }),
}));
// Exercise each hook's real mutation boundary without mounting a screen.
type Mutation = {
  mutationFn: (input: unknown) => Promise<unknown>;
  onSuccess: (result: unknown) => void;
};
const id = "00000000-0000-0000-0000-000000000005";
beforeEach(() => {
  vi.clearAllMocks();
});

describe("print acknowledgement follows the durable response", () => {
  it.each([null, "", {}, { ok: false, message: "Queue rejected" }])(
    "does not queue successfully on %j",
    async (data) => {
      mock.rpc.mockResolvedValue({ data, error: null });
      const mutation = useQueuePrint() as unknown as Mutation;
      await expect(
        mutation.mutationFn({ printer: id, documentType: "pos_receipt" }),
      ).rejects.toThrow();
      expect(mock.success).not.toHaveBeenCalled();
    },
  );
  it("returns the saved job identity and announces queued rather than printed", async () => {
    mock.rpc.mockResolvedValue({ data: id, error: null });
    const mutation = useQueuePrint() as unknown as Mutation;
    const result = await mutation.mutationFn({ printer: id, documentType: "pos_receipt" });
    expect(result).toBe(id);
    mutation.onSuccess(result);
    expect(mock.success).toHaveBeenCalledWith(expect.stringContaining(`Queued ${id}`));
    expect(mock.success).not.toHaveBeenCalledWith("Recorded as printed");
  });
  it("preserves the transport failure", async () => {
    mock.rpc.mockResolvedValue({ data: id, error: { message: "Printer permission denied" } });
    await expect(
      (useQueuePrint() as unknown as Mutation).mutationFn({
        printer: id,
        documentType: "pos_receipt",
      }),
    ).rejects.toThrow("Printer permission denied");
  });
  it.each([null, {}, { ok: false, message: "Result rejected" }, { status: "unknown" }])(
    "does not report an unconfirmed print result %j",
    async (data) => {
      mock.rpc.mockResolvedValue({ data, error: null });
      await expect(
        (useRecordPrintResult() as unknown as Mutation).mutationFn({ job: id, success: true }),
      ).rejects.toThrow();
      expect(mock.success).not.toHaveBeenCalled();
    },
  );
  it("keeps a queued retry distinct from completed physical output", async () => {
    mock.rpc.mockResolvedValue({ data: { status: "queued", failed_over: false }, error: null });
    const mutation = useRecordPrintResult() as unknown as Mutation;
    mutation.onSuccess(await mutation.mutationFn({ job: id, success: false }));
    expect(mock.message).toHaveBeenCalledWith("Failed — queued for another attempt");
    expect(mock.success).not.toHaveBeenCalled();
  });
  it("requires a saved job ID when retrying", async () => {
    mock.rpc.mockResolvedValue({ data: null, error: null });
    await expect((useRetryPrintJob() as unknown as Mutation).mutationFn(id)).rejects.toThrow(
      "persisted job ID",
    );
  });
});

describe("accrual and intake results", () => {
  it.each([null, {}, { ok: false, error: "Posting rejected" }, { ok: true }])(
    "rejects an unproved accrual %j",
    (value) => {
      expect(() => requireAccrualResult(value)).toThrow();
    },
  );
  it("keeps a zero-value skip separate from a posted journal", () => {
    expect(requireAccrualResult({ ok: true, skipped: "zero_value" })).toEqual({
      ok: true,
      skipped: "zero_value",
    });
    expect(requireAccrualResult({ ok: true, journal_id: id })).toEqual({
      ok: true,
      journal_id: id,
    });
  });
  it("rejects a delivery business error even if it contains an old identity", () => {
    expect(() =>
      requireSavedRecord(
        { ok: false, message: "Not permitted", delivery_order_id: id, order_number: "D-1" },
        ["delivery_order_id", "order_number"],
        "Not saved",
      ),
    ).toThrow("Not permitted");
  });
  it("requires both persisted order ID and readable reference", () => {
    expect(() =>
      requireSavedRecord(
        { delivery_order_id: id },
        ["delivery_order_id", "order_number"],
        "Not saved",
      ),
    ).toThrow("Not saved");
    expect(
      requireSavedRecord(
        { delivery_order_id: id, order_number: "D-1" },
        ["delivery_order_id", "order_number"],
        "Not saved",
      )["order_number"],
    ).toBe("D-1");
  });
  it("does not accept an arbitrary toast-shaped value as a print job ID", () => {
    expect(() => requirePrintJobId("queued")).toThrow("persisted job ID");
  });
});

describe("M-Pesa receipt review acknowledgements", () => {
  const payment = "ab000000-0000-4000-8000-000000000001";
  const request = "ab000000-0000-4000-8000-000000000002";
  it("keeps a saved proposal distinct from confirmed money", () => {
    expect(requireMpesaReceiptReviewResult({
      payment_id: payment, request_id: request, status: "pending_approval",
    }, payment)["status"]).toBe("pending_approval");
  });
  it("accepts a provider confirmation that won the submission race", () => {
    expect(requireMpesaReceiptReviewResult({
      payment_id: payment, status: "confirmed",
    }, payment)["status"]).toBe("confirmed");
  });
  it("preserves failed execution as an attention state", () => {
    expect(requireMpesaReceiptReviewResult({
      payment_id: payment, request_id: request, status: "execution_failed",
    }, payment, request)["status"]).toBe("execution_failed");
  });
  it.each([
    null, {}, { payment_id: payment, status: "pending_approval" },
    { payment_id: payment, request_id: "missing", status: "pending_approval" },
    { payment_id: request, request_id: request, status: "pending_approval" },
    { payment_id: payment, request_id: request, status: "completed" },
    { ok: false, payment_id: payment, request_id: request, status: "pending_approval" },
  ])("rejects an unproven submission: %j", (result) => {
    expect(() => requireMpesaReceiptReviewResult(result, payment)).toThrow();
  });
  it("requires the exact request identity for a decision", () => {
    expect(() => requireMpesaReceiptReviewResult({
      payment_id: payment, request_id: payment, status: "completed",
    }, payment, request)).toThrow();
  });
  it("does not accept a pending proposal as a completed decision", () => {
    expect(() => requireMpesaReceiptReviewResult({
      payment_id: payment, request_id: request, status: "pending_approval",
    }, payment, request)).toThrow();
  });
});
