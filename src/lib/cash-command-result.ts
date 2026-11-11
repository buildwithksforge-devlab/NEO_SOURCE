import { guardedRpc } from "@/lib/rpc-guard";
import { requireSavedRecord, rejectBusinessFailure } from "@/lib/durable-command-result";

const commands = new Set([
  "neo_cash_request_payment",
  "neo_cash_request_pos_payment",
  "neo_cash_confirm_receipt",
  "neo_cash_cancel_request",
  "neo_cash_transfer_send",
  "neo_cash_transfer_confirm",
  "neo_cash_transfer_cancel",
  "neo_cash_refund_request",
  "neo_cash_refund_request_v2",
  "neo_cash_refund_decide",
  "neo_cash_refund_settle",
]);
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    !["null", "undefined"].includes(value.trim().toLowerCase())
  );
}
export function validateCashCommandInput(name: string, args: Record<string, unknown>): void {
  if (!commands.has(name)) throw new Error("Unrecognized cash command");
  if (
    "_amount" in args &&
    (typeof args["_amount"] !== "number" ||
      !Number.isFinite(args["_amount"]) ||
      args["_amount"] <= 0)
  )
    throw new Error("Enter a finite payment amount greater than zero.");
  if (
    "_tendered" in args &&
    (typeof args["_tendered"] !== "number" ||
      !Number.isFinite(args["_tendered"]) ||
      args["_tendered"] < Number(args["_amount"]) ||
      Math.abs(Math.round(args["_tendered"] * 100) - args["_tendered"] * 100) > 0.000001)
  )
    throw new Error("Cash tendered must be in cents and at least the payment amount.");
  const identifier =
    name === "neo_cash_request_payment"
      ? "_folio"
      : name === "neo_cash_request_pos_payment"
        ? "_order"
        : name.startsWith("neo_cash_refund_request")
          ? "_payment"
          : name.includes("refund_")
            ? "_refund"
            : name === "neo_cash_confirm_receipt" || name === "neo_cash_cancel_request"
              ? "_request"
              : name === "neo_cash_transfer_send"
                ? null
                : "_transfer";
  if (name === "neo_cash_refund_request_v2" && !text(args["_attempt"]))
    throw new Error("A refund attempt identity is required.");
  if (identifier && !text(args[identifier]))
    throw new Error("Choose the saved record before continuing.");
  if (
    name === "neo_cash_cancel_request" ||
    name === "neo_cash_transfer_cancel" ||
    name.startsWith("neo_cash_refund_request")
  ) {
    if (!text(args["_reason"])) throw new Error("A written reason is required.");
  }
  if (name === "neo_cash_refund_decide" && typeof args["_approve"] !== "boolean")
    throw new Error("Choose an explicit refund decision.");
}

export function requireCashCommandResult(
  name: string,
  args: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  const fallback =
    "The server did not confirm this cash action. Refresh its saved status before retrying.";
  rejectBusinessFailure(value, fallback);
  const result = requireSavedRecord(value, ["status"], fallback),
    status = result["status"];
  const match = (field: string, expected: unknown) => {
    if (result[field] !== expected) throw new Error(fallback);
  };
  const saved = (fields: string[]) => requireSavedRecord(result, fields, fallback);
  if (name === "neo_cash_request_payment" || name === "neo_cash_request_pos_payment") {
    if (status === "no_till") return result;
    // Existing-request replays return the saved request ID without assignment fields.
    if (status === "pending") {
      saved(["request_id"]);
      return result;
    }
    if (status !== "confirmed")
      throw new Error(
        "This cash request was not confirmed or routed to a cashier. Refresh its saved status.",
      );
    saved(["request_id", "payment_id", "receipt_number"]);
    return result;
  }
  if (name === "neo_cash_confirm_receipt") {
    if (status !== "confirmed") throw new Error(fallback);
    match("request_id", args["_request"]);
    saved(["payment_id", "receipt_number"]);
  } else if (name === "neo_cash_cancel_request") {
    if (status !== "cancelled") throw new Error(fallback);
    match("request_id", args["_request"]);
  } else if (name === "neo_cash_transfer_send") {
    if (status !== "in_transit") throw new Error(fallback);
    saved(["transfer_id", "transfer_number"]);
  } else if (name === "neo_cash_transfer_confirm") {
    if (status !== "received") throw new Error(fallback);
    match("transfer_id", args["_transfer"]);
    // The installed idempotent replay intentionally omits transfer_number.
    if (result["idempotent"] !== true) saved(["transfer_number"]);
  } else if (name === "neo_cash_transfer_cancel") {
    if (status !== "cancelled") throw new Error(fallback);
    match("transfer_id", args["_transfer"]);
  } else if (name.startsWith("neo_cash_refund_request")) {
    if (!["pending_approval", "approved", "settled"].includes(String(status)))
      throw new Error(fallback);
    saved(["refund_id"]);
    if (status === "settled") saved(["payment_id", "refund_receipt_number"]);
  } else if (name === "neo_cash_refund_decide") {
    if (status === "settled" && args["_approve"] === true && result["idempotent"] === true) {
      match("refund_id", args["_refund"]);
      saved(["payment_id", "refund_receipt_number"]);
      return result;
    }
    if (status !== (args["_approve"] ? "approved" : "rejected"))
      throw new Error("The saved refund decision differs. Refresh before continuing.");
    match("refund_id", args["_refund"]);
  } else if (name === "neo_cash_refund_settle") {
    if (status !== "settled") throw new Error(fallback);
    match("refund_id", args["_refund"]);
    saved(["payment_id", "refund_receipt_number"]);
  } else throw new Error("Unrecognized cash command");
  return result;
}

/** Preserve the guarded RPC's auth/telemetry and response shape for existing callers. */
export async function confirmedCashRpc<T>(
  client: Parameters<typeof guardedRpc>[0],
  name: string,
  args: Record<string, unknown>,
) {
  validateCashCommandInput(name, args);
  const result = await guardedRpc<T>(client, name, args);
  if (result.error) return result;
  requireCashCommandResult(name, args, result.data);
  return result;
}
