import type { GoLiveReadiness, MenuValidationRow, ReadinessCheck, ReadinessStatus } from "@/lib/go-live";

export class ReadinessContractError extends Error {}
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const statuses = new Set(["ready", "attention", "blocked", "unknown"]);
const menuStates = new Set(["ready", "missing-mapping", "missing-recipe", "missing-image", "invalid-relationship", "draft"]);
const internalRoute = (v: unknown) => text(v) && v.startsWith("/") && !v.startsWith("//") && !v.includes(String.fromCharCode(92));
const fail = (): never => { throw new ReadinessContractError("Readiness evidence is incomplete or does not match the selected property. Refresh or report this error."); };

/** A malformed or contradictory verdict cannot certify a property. */
export function parseGoLiveReadiness(value: unknown, branchId: string | null): GoLiveReadiness {
  if (!record(value) || value["branch_id"] !== branchId || !text(value["generated_at"]) || !Number.isFinite(Date.parse(value["generated_at"]))
      || !statuses.has(String(value["status"])) || !Array.isArray(value["checks"])) return fail();
  const keys = new Set<string>();
  const checks: ReadinessCheck[] = value["checks"].map((row: unknown) => {
    if (!record(row) || !text(row["key"]) || keys.has(row["key"]) || !text(row["domain"]) || !text(row["label"])
        || typeof row["detail"] !== "string" || !statuses.has(String(row["status"])) || !internalRoute(row["route"])
        || typeof row["count"] !== "number" || !Number.isSafeInteger(row["count"]) || row["count"] < 0
        || (row["extra"] !== undefined && !record(row["extra"]))) return fail();
    keys.add(row["key"]);
    return row as ReadinessCheck;
  });
  const status = value["status"] as ReadinessStatus;
  if ((!checks.length && status !== "unknown") || (status === "ready" && checks.some(c => c.status !== "ready"))
      || (status !== "blocked" && checks.some(c => c.status === "blocked"))
      || (status === "attention" && checks.some(c => c.status === "unknown"))) return fail();
  return { branch_id: branchId, generated_at: value["generated_at"], status, checks };
}

/** Null/error payloads are not evidence of an empty or fully configured menu. */
export function parseMenuValidationRows(value: unknown, branchId: string | null): MenuValidationRow[] {
  if (!Array.isArray(value)) return fail();
  const ids = new Set<string>();
  return value.map((row: unknown) => {
    if (!record(row) || !text(row["item_id"]) || ids.has(row["item_id"]) || !text(row["name"])
        || !(row["branch_id"] === null || text(row["branch_id"]))
        || (branchId !== null && row["branch_id"] !== null && row["branch_id"] !== branchId)
        || !menuStates.has(String(row["state"])) || !Array.isArray(row["issues"]) || !row["issues"].every(text)
        || (row["state"] === "ready" && row["issues"].length > 0)) return fail();
    ids.add(row["item_id"]);
    return row as MenuValidationRow;
  });
}
