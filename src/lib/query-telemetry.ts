/**
 * Lightweight query telemetry.
 *
 * PostgREST rejects a select that names a column the table does not have with
 * a schema error rather than an empty result. Those are contract defects, not
 * transient failures, so they are logged loudly (and surfaced once per session)
 * instead of dying silently inside a react-query error boundary.
 */

export type QueryErrorLike = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
} | null;

export type QueryErrorReport = {
  /** Logical surface, e.g. "inventory.stock_items". */
  context: string;
  /** True when the failure is a schema/contract mismatch, not a data error. */
  schemaMismatch: boolean;
  code: string | null;
  message: string;
};

/** PostgREST codes that mean "the select references something that isn't there". */
const SCHEMA_CODES = new Set(["42703", "42P01", "PGRST204", "PGRST200", "PGRST100"]);

export function isSchemaMismatch(error: QueryErrorLike): boolean {
  if (!error) return false;
  if (error.code && SCHEMA_CODES.has(error.code)) return true;
  const text = `${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  return (
    text.includes("does not exist") ||
    text.includes("could not find") ||
    text.includes("unknown column")
  );
}

type Listener = (report: QueryErrorReport) => void;

const listeners = new Set<Listener>();
const seen = new Set<string>();

/** Subscribe an alerting sink (console is always used in addition). */
export function onQueryError(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reset dedupe + sinks. Test-only. */
export function resetQueryTelemetry() {
  listeners.clear();
  seen.clear();
}

export function reportQueryError(context: string, error: QueryErrorLike): QueryErrorReport {
  const report: QueryErrorReport = {
    context,
    schemaMismatch: isSchemaMismatch(error),
    code: error?.code ?? null,
    message: error?.message ?? "Unknown query error",
  };

  const key = `${context}:${report.code ?? ""}:${report.message}`;
  if (!seen.has(key)) {
    seen.add(key);
    // eslint-disable-next-line no-console
    console.error(
      `[query-telemetry] ${report.schemaMismatch ? "schema mismatch" : "query failure"} in ${context}`,
      { code: report.code, message: report.message },
    );
    for (const listener of listeners) {
      try {
        listener(report);
      } catch {
        /* an alert sink must never break the query path */
      }
    }
  }
  return report;
}
