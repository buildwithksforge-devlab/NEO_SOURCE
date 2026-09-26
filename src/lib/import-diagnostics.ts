/**
 * Denial diagnostics for operator-run imports.
 *
 * An import can fail for two very different reasons, and telling them apart is
 * the difference between "ask an administrator for the capability" and "fix
 * row 14 of your spreadsheet". The database returns both as an error object,
 * so this classifies the response once and every import surface reports the
 * same category, the same correlation ID and the same recommended next action.
 */

export type DenialCategory = "permission" | "validation" | "system";

export type ImportDiagnosis = {
  category: DenialCategory;
  title: string;
  detail: string;
  nextAction: string;
  code: string | null;
};

type PostgrestLike = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

/** A short, human-readable correlation ID shared by the UI, the audit trail and the log line. */
export function newCorrelationId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().split("-")[0]
      : Math.random().toString(16).slice(2, 10);
  return `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${random}`;
}

/** Row-level security and privilege refusals arrive as 42501, or as a plain RLS message. */
function isPermissionDenial(code: string | null, message: string): boolean {
  if (code === "42501" || code === "PGRST301" || code === "401" || code === "403") return true;
  const m = message.toLowerCase();
  return (
    m.includes("row-level security") ||
    m.includes("row level security") ||
    m.includes("permission denied") ||
    m.includes("not authorized")
  );
}

/** Constraint, type and payload problems: the data is wrong, not the person. */
function isValidationFailure(code: string | null): boolean {
  if (!code) return false;
  return (
    code.startsWith("22") || // data exception (bad number, bad date, too long)
    code.startsWith("23") || // integrity constraint (null, unique, foreign key, check)
    code === "PGRST204" || // unknown column in the payload
    code === "PGRST116"
  );
}

export function diagnoseImportError(
  error: unknown,
  context: { subject: string; capability: string },
): ImportDiagnosis {
  const e = (error ?? {}) as PostgrestLike;
  const code = e.code ? String(e.code) : null;
  const message = (e.message ?? (error instanceof Error ? error.message : "")) || "Unknown error";
  const extra = [e.details, e.hint].filter(Boolean).join(" · ");
  const detail = extra ? `${message} — ${extra}` : message;

  if (isPermissionDenial(code, message)) {
    return {
      category: "permission",
      title: "Refused by your access rules",
      detail,
      nextAction: `Your account does not hold ${context.capability} for this property. Ask an administrator to grant it on your role, or switch to the property this ${context.subject} belongs to, then retry — nothing was saved.`,
      code,
    };
  }

  if (isValidationFailure(code)) {
    return {
      category: "validation",
      title: "The file contents were rejected",
      detail,
      nextAction:
        "Correct the highlighted rows in your file — usually a missing required value, a duplicate name, or a price that is not a number — then upload it again.",
      code,
    };
  }

  return {
    category: "system",
    title: "The import could not be completed",
    detail,
    nextAction:
      "Nothing was saved. Retry once; if it fails again, quote the correlation ID below to your administrator so the attempt can be traced in the audit trail.",
    code,
  };
}
