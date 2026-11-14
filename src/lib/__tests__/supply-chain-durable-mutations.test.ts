import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useThreeWayMatch,
  useAcceptSupplierInvoice,
  useCaptureSupplierInvoice,
} from "@/lib/procurement-data";
import { useRaiseReorderRequest, usePostReceipt, usePostTransfer, useCloseStockTake } from "@/lib/inventory-data";
import { useAdvanceSupplierPayment, useReleasePaymentSchedule } from "@/lib/finance-data";
import { useReceiveGoods } from "@/lib/stores-lifecycle";
import {
  requireMatchResult,
  requireSupplierPaymentResult,
  requireStockCommandResult,
  requireScheduleReleaseResult,
  requireGoodsReceiptResult,
} from "@/lib/supply-command-result";
import { invalidateSupplyViews, SUPPLY_VIEW_KEYS } from "@/lib/supply-view-refresh";
const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: m.from } }));
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: m.rpc }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (o: unknown) => o,
  useQuery: vi.fn(),
  useQueryClient: () => ({ invalidateQueries: m.invalidate }),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    organizationId: "org",
    profile: { branch_id: "branch" },
    user: { id: "actor" },
  }),
}));
vi.mock("@/lib/branch-filter", () => ({ useActivePropertyFilter: () => ({ branchId: "branch" }) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: m.success, warning: m.warning, error: m.error, info: m.info },
}));
type Mutation = {
  mutationFn: (input: any) => Promise<any>;
  onSuccess: (result: any, input?: any) => unknown;
};
const mutation = (value: unknown) => value as Mutation;
const id = "a3000000-0000-4000-8000-000000000001",
  journal = "a3000000-0000-4000-8000-000000000002";
beforeEach(() => {
  vi.clearAllMocks();
  m.invalidate.mockResolvedValue(undefined);
});
describe("saved supply-chain result boundaries", () => {
  it.each([
    null,
    {},
    { ok: false },
    { discrepancies: 0, critical: 0 },
    { discrepancies: 0, critical: 1, match_status: "matched" },
    { discrepancies: NaN, critical: 0, match_status: "matched" },
    { discrepancies: 1, critical: 0, match_status: "matched" },
  ])("never reports an unverifiable invoice as matched: %j", async (data) => {
    m.rpc.mockResolvedValue({ data, error: null });
    await expect(mutation(useThreeWayMatch()).mutationFn(id)).rejects.toThrow();
    expect(m.success).not.toHaveBeenCalled();
  });
  it.each([
    { discrepancies: 0, critical: 0, match_status: "matched" },
    { discrepancies: 1, critical: 0, match_status: "review" },
    { discrepancies: 2, critical: 1, match_status: "held" },
  ])("accepts the real match response shape: %j", (data) =>
    expect(requireMatchResult(data)).toEqual(data),
  );
  it.each([
    null,
    {},
    { ok: false, journal_id: journal },
    { ok: true, journal_id: null },
    { ok: true, journal_id: "not-a-journal" },
  ])("does not call missing journal evidence posted: %j", async (data) => {
    m.rpc.mockResolvedValue({ data, error: null });
    await expect(
      mutation(useAcceptSupplierInvoice()).mutationFn({ invoiceId: id }),
    ).rejects.toThrow();
  });
  it("accepts saved invoice journal evidence", async () => {
    const data = { ok: true, journal_id: journal };
    m.rpc.mockResolvedValue({ data, error: null });
    expect(await mutation(useAcceptSupplierInvoice()).mutationFn({ invoiceId: id })).toEqual(data);
  });
  it("invoice capture needs both its saved ID and match result", async () => {
    m.rpc.mockResolvedValue({ data: { ok: true, invoice_id: id }, error: null });
    await expect(
      mutation(useCaptureSupplierInvoice()).mutationFn({
        supplierId: id,
        invoiceNumber: "TEST",
        invoiceDate: "2026-11-10",
        lines: [],
      }),
    ).rejects.toThrow();
  });
  it.each([usePostReceipt, usePostTransfer, useCloseStockTake])(
    "stock commands do not accept an empty RPC result",
    async (hook) => {
      m.rpc.mockResolvedValue({ data: null, error: null });
      await expect(mutation(hook()).mutationFn(id)).rejects.toThrow();
    },
  );
  it("stock receipt can be saved while Finance is still pending", async () => {
    const data = { status: "pending-finance", finance_error: "Period closed" };
    m.rpc.mockResolvedValue({ data, error: null });
    const hook = mutation(usePostReceipt());
    await hook.onSuccess(await hook.mutationFn(id));
    expect(m.warning).toHaveBeenCalledWith(expect.stringContaining("Finance accrual"));
    expect(m.success).not.toHaveBeenCalled();
    expect(m.invalidate).toHaveBeenCalledWith({ queryKey: ["finance-posting"] });
  });
  it("atomic receiving preserves a partial Finance handoff", async () => {
    const data = {
      ok: true,
      receipt_id: id,
      grn_number: "TEST-GRN",
      posting: { status: "pending-finance" },
    };
    m.rpc.mockResolvedValue({ data, error: null });
    const hook = mutation(useReceiveGoods());
    await hook.onSuccess(
      await hook.mutationFn({ orderId: id, locationId: id, lines: [], attemptKey: id }),
    );
    expect(m.warning).toHaveBeenCalledWith(expect.stringContaining("Finance accrual"));
    expect(m.success).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { ok: false },
    { ok: true, receipt_id: id, grn_number: "TEST" },
    { ok: true, receipt_id: id, grn_number: "TEST", posting: { status: "failed" } },
  ])("receiving requires saved stock posting evidence: %j", (data) =>
    expect(() => requireGoodsReceiptResult(data)).toThrow(),
  );
  it("completed transfers and replayed stock takes are valid stock outcomes", () => {
    expect(requireStockCommandResult({ status: "completed" }, "transfer")["status"]).toBe(
      "completed",
    );
    expect(requireStockCommandResult({ status: "already-closed" }, "stock-take")["status"]).toBe(
      "already-closed",
    );
  });
  it.each([
    null,
    {},
    { ok: false, detail: "Bank not confirmed" },
    { ok: true, payment_id: id, status: "paid", journal_id: null },
    { ok: true, payment_id: "another", status: "paid", journal_id: journal },
  ])("does not accept incomplete supplier settlement: %j", (data) =>
    expect(() => requireSupplierPaymentResult(data, id, "settle")).toThrow(),
  );
  it("successful settlement has a matching payment and journal", () =>
    expect(
      requireSupplierPaymentResult(
        { ok: true, payment_id: id, status: "paid", journal_id: journal },
        id,
        "settle",
      ).journal_id,
    ).toBe(journal));
  it("requested mark-failed is distinct from an unsuccessful settlement", async () => {
    const data = { ok: false, payment_id: id, status: "failed" };
    expect(() => requireSupplierPaymentResult(data, id, "settle")).toThrow();
    m.rpc.mockResolvedValue({ data, error: null });
    const hook = mutation(useAdvanceSupplierPayment());
    const input = { paymentId: id, action: "fail", reason: "Bank declined" };
    await hook.onSuccess(await hook.mutationFn(input), input);
    expect(m.success).toHaveBeenCalledWith("Payment marked failed; no settlement recorded.");
  });
  it.each([
    null,
    {},
    { ok: false, payment_id: id, payment_number: "TEST", status: "released" },
    { ok: true, payment_id: id, payment_number: "TEST", status: "draft" },
  ])("does not fabricate schedule release evidence: %j", (data) =>
    expect(() => requireScheduleReleaseResult(data)).toThrow(),
  );
  it("schedule release uses the real persisted payment", async () => {
    const data = { ok: true, payment_id: id, payment_number: "TEST", status: "released" };
    m.rpc.mockResolvedValue({ data, error: null });
    expect(await mutation(useReleasePaymentSchedule()).mutationFn({ scheduleId: id })).toEqual(
      data,
    );
  });
});
describe("replenishment saved request evidence",()=>{
 it("rejects a missing saved request ID",async()=>{m.rpc.mockResolvedValue({data:{},error:null});await expect(mutation(useRaiseReorderRequest()).mutationFn({item:{id},quantity:2})).rejects.toThrow("not saved");});
 it("rejects nonfinite request quantities before any database call",async()=>{await expect(mutation(useRaiseReorderRequest()).mutationFn({item:{id},quantity:Infinity})).rejects.toThrow("finite positive");expect(m.rpc).not.toHaveBeenCalled();});
});
describe("connected supply and Finance view refresh", () => {
  it("covers all connected existing view roots without duplicate requests", async () => {
    await invalidateSupplyViews({ invalidateQueries: m.invalidate }, [
      "inventory",
      "custom-review",
    ]);
    const roots = m.invalidate.mock.calls.map((x) => x[0].queryKey[0]);
    expect(new Set(roots).size).toBe(roots.length);
    for (const key of [
      "procurement",
      "procurement-department",
      "inventory",
      "stores-department",
      "stock-needs",
      "finance",
      "finance-posting",
      "financial-states",
      "neo-facts",
      "reconciliation",
      "ops",
      "custom-review",
    ])
      expect(roots).toContain(key);
    expect(SUPPLY_VIEW_KEYS).toContain("cash");
  });
  it("keeps a successful mutation pending until its connected refreshes finish", async () => {
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    m.invalidate.mockImplementation(({ queryKey }) =>
      queryKey[0] === "finance" ? waiting : Promise.resolve(),
    );
    const hook = mutation(usePostReceipt());
    let done = false;
    const result = Promise.resolve(hook.onSuccess({ status: "posted" })).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await result;
    expect(done).toBe(true);
  });
});
