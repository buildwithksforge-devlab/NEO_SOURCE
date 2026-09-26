/**
 * The seven states a dashboard card may render.
 *
 * A card shows exactly one of these — never a zero standing in for "not loaded
 * yet", never "Awaiting data" while the operational module holds records.
 */
export type CardState =
  | "loading"
  | "ready"
  | "no-records"
  | "not-configured"
  | "access-denied"
  | "select-property"
  | "query-failed"
  | "not-implemented";

export type CardStateInput = {
  /** False when the backing module has not been built yet. */
  implemented?: boolean;
  /** False when the reader lacks the card's required capability. */
  permitted?: boolean;
  /**
   * False when the prerequisite master data is missing (no property, no rooms,
   * no chart of accounts …) so the figure cannot exist yet. Undefined means
   * "no configuration prerequisite".
   */
  configured?: boolean | undefined;
  isLoading?: boolean;
  /** True once at least one fetch has settled — guards against zero-while-loading. */
  hasLoaded?: boolean;
  error?: unknown;
  /**
   * True when the reader must choose a property before the source can answer
   * (their access does not cover the whole organisation).
   */
  scopeSelectionRequired?: boolean;
  /** Resolved figure. `null` means the source produced no row for this scope. */
  value?: number | null | undefined;
};

const PERMISSION_CODES = new Set(["42501", "PGRST301", "401", "403"]);

/** A refusal by the database is an access state, not a query failure. */
export function isPermissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; status?: unknown; message?: unknown };
  const code = e.code == null ? "" : String(e.code);
  const status = e.status == null ? "" : String(e.status);
  if (PERMISSION_CODES.has(code) || PERMISSION_CODES.has(status)) return true;
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return message.includes("permission denied") || message.includes("row-level security");
}

/**
 * Single resolver every card uses, so the same conditions always produce the
 * same state on every dashboard.
 */
export function resolveCardState(input: CardStateInput): CardState {
  if (input.implemented === false) return "not-implemented";
  if (input.permitted === false) return "access-denied";
  if (input.scopeSelectionRequired) return "select-property";
  if (input.error) return isPermissionError(input.error) ? "access-denied" : "query-failed";
  if (input.isLoading || input.hasLoaded === false) return "loading";
  if (input.configured === false) return "not-configured";
  if (input.value === null || input.value === undefined) return "no-records";
  if (!Number.isFinite(input.value)) return "query-failed";
  return "ready";
}

export const CARD_STATE_COPY: Record<CardState, { label: string; note: string }> = {
  loading: { label: "Loading…", note: "Reading the operational source" },
  ready: { label: "", note: "" },
  "no-records": { label: "No records", note: "Nothing in this scope for the selected period" },
  "not-configured": { label: "Not configured", note: "Set up the prerequisite records first" },
  "access-denied": { label: "Access denied", note: "Your role does not include this figure" },
  "select-property": {
    label: "Select a property",
    note: "Your access covers specific properties — choose one to read this figure",
  },
  "query-failed": { label: "Query failed", note: "The source could not be read — retry or report" },
  "not-implemented": { label: "Not implemented", note: "Available once the module is built" },
};
