/**
 * Account & access audit inspection.
 *
 * The Users page audit panel answers who changed what, when, and why, with the
 * before and after state of each field. Audit payloads are redacted here before
 * they reach the interface: any key that could carry credential material is
 * dropped, so an audit record can never become a way to read a secret.
 */

export type AuditRow = {
  id: string;
  created_at: string;
  action: string;
  module: string | null;
  user_name: string | null;
  reason?: string | null;
  previous_value?: unknown;
  new_value?: unknown;
};

export type AuditCategory = "security" | "status" | "assignment" | "profile" | "other";

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  security: "Security & sign-in",
  status: "Account status",
  assignment: "Assignment & roles",
  profile: "Profile & details",
  other: "Other activity",
};

export const AUDIT_CATEGORY_ORDER: AuditCategory[] = [
  "security",
  "status",
  "assignment",
  "profile",
  "other",
];

const CATEGORY_PATTERNS: Array<{ category: AuditCategory; pattern: RegExp }> = [
  { category: "security", pattern: /(password|mfa|session|invitation|auth|two_factor|2fa)/i },
  { category: "status", pattern: /(suspend|lock|activate|deactivate|offboard|delete|status)/i },
  { category: "assignment", pattern: /(role|permission|assign|transfer|branch|department|station|owner)/i },
  { category: "profile", pattern: /(profile|photo|contact|phone|name|detail)/i },
];

export function classifyAuditAction(action: string): AuditCategory {
  for (const { category, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(action)) return category;
  }
  return "other";
}

/** Keys whose values are never surfaced, whatever a writer stored. */
const SECRET_KEY = /(password|passwd|hash|token|secret|recovery|otp|seed|private|credential|apikey|api_key)/i;

export function isSecretKey(key: string): boolean {
  // A boolean requirement flag is safe and useful; a value is not.
  if (/^must_change_password$/i.test(key)) return false;
  return SECRET_KEY.test(key);
}

/** Object form of an audit payload with every credential-bearing key removed. */
export function redactAuditValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value === null || value === undefined ? {} : { value };
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) continue;
    out[key] = raw && typeof raw === "object" ? redactAuditValue(raw) : raw;
  }
  return out;
}

export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export type AuditFieldChange = { field: string; before: string; after: string };

/** Field-level before/after list for one audit row, secrets already removed. */
export function auditFieldDiff(previous: unknown, next: unknown): AuditFieldChange[] {
  const before = redactAuditValue(previous);
  const after = redactAuditValue(next);
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return fields
    .map((field) => ({
      field,
      before: formatAuditValue(before[field]),
      after: formatAuditValue(after[field]),
    }))
    .filter((row) => row.before !== row.after);
}

export type AuditFilter = {
  category?: AuditCategory | "all";
  search?: string;
  /** ISO dates, inclusive. */
  from?: string | null;
  to?: string | null;
};

export function filterAuditRows(rows: AuditRow[], filter: AuditFilter): AuditRow[] {
  const term = (filter.search ?? "").trim().toLowerCase();
  const from = filter.from ? new Date(filter.from).getTime() : null;
  const to = filter.to ? new Date(filter.to).getTime() + 86_400_000 - 1 : null;
  return rows.filter((row) => {
    if (filter.category && filter.category !== "all" && classifyAuditAction(row.action) !== filter.category)
      return false;
    const at = new Date(row.created_at).getTime();
    if (from !== null && at < from) return false;
    if (to !== null && at > to) return false;
    if (!term) return true;
    const haystack = [row.action, row.module, row.user_name, row.reason]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  });
}

/** Readable action title, e.g. `user.mfa_reset` → "Mfa reset". */
export function auditActionLabel(action: string): string {
  const tail = action.includes(".") ? action.slice(action.indexOf(".") + 1) : action;
  const words = tail.replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
