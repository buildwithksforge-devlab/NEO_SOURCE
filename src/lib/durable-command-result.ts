/** Validate durable command responses before a mutation can report success. */
type CommandRecord = Record<string, unknown>;

/** A successful RPC transport is not proof that a payment was saved or confirmed. */
export function requirePosPaymentResult(
  value: unknown,
  expected: { paymentId?: string; confirmed?: boolean } = {},
): CommandRecord {
  const fallback = "No saved payment was confirmed. Check the existing attempt before taking another payment.";
  const result = requireSavedRecord(value, ["payment_id", "status"], fallback);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(result["payment_id"]))
      || (expected.paymentId && result["payment_id"] !== expected.paymentId)
      || !["initiated", "pending", "confirmed"].includes(String(result["status"]))
      || (expected.confirmed && result["status"] !== "confirmed")) {
    throw new Error(fallback);
  }
  return result;
}

export function rejectBusinessFailure(value: unknown, fallback: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const result = value as CommandRecord;
  if (result["ok"] === false || result["success"] === false) {
    const detail = result["detail"] ?? result["message"] ?? result["error"] ?? result["reason"];
    throw new Error(typeof detail === "string" && detail.trim() ? detail : fallback);
  }
}

export function requireSavedRecord(
  value: unknown,
  fields: readonly string[],
  fallback: string,
): CommandRecord {
  rejectBusinessFailure(value, fallback);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(fallback);
  const result = value as CommandRecord;
  if (fields.some((field) => typeof result[field] !== "string" || !String(result[field]).trim() || ["null", "undefined"].includes(String(result[field]).trim().toLowerCase()))) {
    throw new Error(fallback);
  }
  return result;
}

export function requirePrintJobId(value: unknown): string {
  const message = "The print job was not saved — no persisted job ID was returned.";
  rejectBusinessFailure(value, message);
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(message);
  }
  return value;
}

export function requirePrintResult(value: unknown): CommandRecord {
  const result = requireSavedRecord(value, ["status"], "No confirmed print result was returned.");
  if (!["completed", "queued", "failed"].includes(String(result["status"]))) {
    throw new Error(
      "The printer returned an unrecognised result. Check the saved job before retrying.",
    );
  }
  return result;
}

export function requireAccrualResult(value: unknown): CommandRecord {
  const message = "Delivery accrual was not posted — no successful journal result was returned.";
  rejectBusinessFailure(value, message);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const result = value as CommandRecord;
  if (result["ok"] !== true) throw new Error(message);
  if (result["skipped"] === "zero_value") return result;
  return requireSavedRecord(result, ["journal_id"], message);
}

/** A delivered guest laundry charge is successful only with its saved folio line. */
export function requireLaundryPostingResult(value: unknown): CommandRecord {
  const fallback = "The laundry charge was not confirmed on the guest folio.";
  const record =
    value && typeof value === "object" && !Array.isArray(value) ? (value as CommandRecord) : null;
  const detail = record?.["detail"] ?? record?.["message"] ?? record?.["reason"];
  const message = typeof detail === "string" && detail.trim() ? detail : fallback;
  const result = requireSavedRecord(value, ["folio_id", "folio_line_id"], message);
  if (result["ok"] !== true || result["folio_charged"] !== true) throw new Error(message);
  return result;
}

/** A receipt proposal is distinct from a confirmed payment. */
export function requireMpesaReceiptReviewResult(
  value: unknown,
  paymentId: string,
  requestId?: string,
): CommandRecord {
  const message = "Receipt review was not confirmed as saved. Check the existing payment before retrying.";
  const result = requireSavedRecord(value, ["payment_id", "status"], message);
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (result["payment_id"] !== paymentId || !uuid.test(paymentId)) throw new Error(message);
  if (!requestId && result["status"] === "confirmed") {
    return requirePosPaymentResult(result, { paymentId, confirmed: true });
  }
  const saved = requireSavedRecord(result, ["request_id"], message);
  const states = requestId
    ? ["completed", "rejected", "returned_for_correction", "execution_failed"]
    : ["pending_approval", "approved_pending_execution", "executing", "execution_failed"];
  if (!uuid.test(String(saved["request_id"]))
      || (requestId && saved["request_id"] !== requestId)
      || !states.includes(String(saved["status"]))) throw new Error(message);
  return saved;
}
