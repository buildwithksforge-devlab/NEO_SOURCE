/** Validate durable command responses before a mutation can report success. */
type CommandRecord = Record<string, unknown>;

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
