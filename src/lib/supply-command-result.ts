import { rejectBusinessFailure, requireSavedRecord } from "@/lib/durable-command-result";
type RecordValue = Record<string, unknown>;
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function object(value: unknown, message: string): RecordValue {
  rejectBusinessFailure(value, message);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as RecordValue;
}
export function requireMatchResult(value: unknown): RecordValue {
  const result = object(value, "Invoice matching was not verified.");
  const total = result["discrepancies"],
    critical = result["critical"];
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    typeof critical !== "number" ||
    !Number.isSafeInteger(critical) ||
    critical < 0 ||
    critical > total
  )
    throw new Error("Invoice matching counts were not verified.");
  const expected = critical > 0 ? "held" : total > 0 ? "review" : "matched";
  if (result["match_status"] !== expected)
    throw new Error("Invoice matching state disagrees with its discrepancies.");
  return result;
}
export function requireLpoActionResult(value: unknown, action: string): RecordValue {
  const result = object(value, "The purchase order action was not confirmed.");
  if (result["status"] !== "ok" || result["action"] !== action)
    throw new Error("The purchase order action was not confirmed.");
  return result;
}
export function requireOrderCloseResult(value: unknown, id: string): RecordValue {
  const result = object(value, "Purchase order closure was not verified.");
  if (result["ok"] !== true || result["order_id"] !== id || result["status"] !== "closed")
    throw new Error("Purchase order closure was not verified.");
  return result;
}
export function requireInvoiceCaptureResult(value: unknown): RecordValue {
  const result = requireSavedRecord(value, ["invoice_id"], "The supplier invoice was not saved.");
  if (result["ok"] !== true) throw new Error("The supplier invoice was not saved.");
  requireMatchResult(result["match"]);
  return result;
}
export function requireSupplierJournalResult(value: unknown): RecordValue {
  const result = object(value, "The supplier invoice journal was not confirmed.");
  if (result["ok"] !== true || !uuid(result["journal_id"]))
    throw new Error("The supplier invoice journal was not confirmed.");
  return result;
}
export type StockCommand = "receipt" | "transfer" | "adjustment" | "stock-take";
export function requireStockCommandResult(value: unknown, command: StockCommand): RecordValue {
  const result = object(value, "The saved stock result was not verified.");
  const accepted: Record<StockCommand, readonly string[]> = {
    receipt: ["posted", "already-posted", "pending-finance"],
    transfer: ["completed", "already-posted"],
    adjustment: ["posted", "already-posted"],
    "stock-take": ["closed", "already-closed"],
  };
  if (typeof result["status"] !== "string" || !accepted[command].includes(result["status"]))
    throw new Error("The saved stock result was not verified.");
  return result;
}
export function requireMovementId(value: unknown): string {
  rejectBusinessFailure(value, "The stock movement was not saved.");
  if (!uuid(value)) throw new Error("The stock movement was not saved.");
  return value;
}
export type SupplierPaymentResult = {
  ok: boolean;
  payment_id: string;
  status: string;
  idempotent?: boolean;
  journal_id?: string | null;
  detail?: string;
};
export function requireSupplierPaymentResult(
  value: unknown,
  id: string,
  action: string,
): SupplierPaymentResult {
  const requestedFailure = Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    action === "fail" &&
    (value as RecordValue)["status"] === "failed" &&
    (value as RecordValue)["payment_id"] === id,
  );
  const result = requestedFailure
    ? (value as RecordValue)
    : object(value, "Supplier payment action was not verified.");
  const expected: Record<string, string> = {
    submit: "awaiting-approval",
    approve: "approved",
    release: "released",
    settle: "paid",
    fail: "failed",
  };
  if (
    (!requestedFailure && result["ok"] !== true) ||
    result["payment_id"] !== id ||
    result["status"] !== expected[action] ||
    (result["status"] === "paid" && !uuid(result["journal_id"]))
  )
    throw new Error("Supplier payment action lacks matching saved payment and journal evidence.");
  return result as SupplierPaymentResult;
}
export type SupplierScheduleResult = {
  ok: boolean;
  payment_id: string;
  payment_number: string;
  status: string;
  idempotent?: boolean;
};
export function requireScheduleReleaseResult(value: unknown): SupplierScheduleResult {
  const result = requireSavedRecord(
    value,
    ["payment_id", "payment_number", "status"],
    "The scheduled payment was not released.",
  );
  if (result["ok"] !== true || !uuid(result["payment_id"]))
    throw new Error("The scheduled payment was not released.");
  if (result["idempotent"] !== true && result["status"] !== "released")
    throw new Error("The scheduled payment was not released.");
  return result as SupplierScheduleResult;
}

export function requireGoodsReceiptResult(value: unknown): RecordValue {
  const result = requireSavedRecord(
    value,
    ["receipt_id", "grn_number"],
    "The goods receipt was not saved.",
  );
  if (result["ok"] !== true) throw new Error("The goods receipt was not saved.");
  requireStockCommandResult(result["posting"], "receipt");
  return result;
}

export function requireBlindReceiptResult(value: unknown, countId: string): RecordValue {
  const result = object(value, "The approved count was not posted.");
  if (
    result["ok"] !== true ||
    result["count_id"] !== countId ||
    result["status"] !== "posted" ||
    !uuid(result["grn_id"])
  )
    throw new Error("The approved count lacks its matching saved GRN. Refresh before retrying.");
  if (result["replayed"] !== true) requireGoodsReceiptResult(result["lifecycle_result"]);
  return result;
}

export function requireReceivingReviewResult(
  value: unknown,
  countId: string,
  decision: "approved" | "rejected",
): RecordValue {
  const result = object(value, "The receiving review was not confirmed.");
  if (result["ok"] !== true || result["count_id"] !== countId)
    throw new Error("The receiving review does not match this count. Refresh before retrying.");
  if (decision === "rejected") {
    if (result["status"] !== "rejected") throw new Error("Receiving rejection was not confirmed.");
  } else if (result["status"] === "posted") {
    if (result["stock_posted"] !== true || !uuid(result["grn_id"]))
      throw new Error("The approved receiving lacks its saved GRN.");
    requireBlindReceiptResult(result["posting_result"], countId);
  } else if (result["status"] !== "approved" || result["stock_posted"] !== false) {
    throw new Error("The receiving approval or posting state was not confirmed.");
  }
  return result;
}
