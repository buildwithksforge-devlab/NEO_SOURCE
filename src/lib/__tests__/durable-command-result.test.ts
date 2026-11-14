import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  requireAccrualResult,
  requirePrintJobId,
  requireSavedRecord,
} from "@/lib/durable-command-result";
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
