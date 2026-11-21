import { requireSavedRecord } from "@/lib/durable-command-result";
export function requireRefundRequest(value: unknown) {
  const r = requireSavedRecord(
    value,
    ["request_id", "status"],
    "The refund request was not saved. Keep the same attempt and retry.",
  );
  if (r["ok"] !== true || !["pending", "approved", "processed"].includes(String(r["status"])))
    throw Error("The refund request was not confirmed.");
  return r;
}
export function requireRefundDecision(value: unknown, id: string, approve: boolean) {
  const r = requireSavedRecord(
    value,
    ["request_id", "status"],
    "The refund decision was not saved.",
  );
  if (
    r["ok"] !== true ||
    r["request_id"] !== id ||
    !(approve
      ? ["approved", "processed"].includes(String(r["status"]))
      : r["status"] === "rejected")
  )
    throw Error("The saved refund decision differs. Refresh before continuing.");
  return r;
}
export function requireRefundPayout(value: unknown) {
  const r = requireSavedRecord(
    value,
    ["refund_id", "payment_id", "refund_receipt_number", "journal_id", "status"],
    "The completed refund and its journal were not confirmed. Check saved evidence before retrying.",
  );
  if (r["ok"] !== true || r["status"] !== "settled")
    throw Error("The refund payout was not confirmed.");
  return r;
}
export function validateRefundAmount(amount: number, reason: string) {
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    Math.abs(Math.round(amount * 100) - amount * 100) > 0.000001
  )
    throw Error("Enter a finite positive refund amount in cents.");
  if (reason.trim().length < 3 || reason.trim().length > 500)
    throw Error("Enter a refund reason of 3 to 500 characters.");
}
