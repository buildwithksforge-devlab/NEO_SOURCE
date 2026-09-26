/**
 * Dashboard read-model reconciliation.
 *
 * A dashboard number is only trustworthy when it is the *same question* the
 * workspace behind it asks: same property scope, same date scope, same
 * lifecycle definition. Historically the two drifted — a card counted "open"
 * with one set of statuses while the page it linked to used another, or the
 * card was organisation-wide while the page was property-scoped — and the
 * operator was left to guess which one lied.
 *
 * This module makes the contract explicit and testable. A metric declares the
 * scope and lifecycle it reads; the workspace declares the same; a mismatch is
 * a defect the tests catch, not something an operator discovers after refresh.
 *
 * It also fixes the two display lies:
 *   - a count may not render as `0` before its query has settled;
 *   - a "no issues" state may not render green while any canonical exception
 *     exists, or while the exception check itself did not complete.
 */

export type PropertyScope = "property" | "organisation" | "department" | "assignee";
export type DateScope = "business-date" | "range" | "open-ended" | "as-of-now";

/** The question a card asks, stated so a workspace can be held to it. */
export type ReadModelContract = {
  /** Stable metric id, e.g. `housekeeping.rooms.to_clean`. */
  metric: string;
  /** Route of the workspace that must agree with this number. */
  workspace: string;
  propertyScope: PropertyScope;
  dateScope: DateScope;
  /** Canonical lifecycle states counted, sorted for comparison. */
  lifecycle: readonly string[];
  /** Optional extra predicate label both sides must share, e.g. `assigned_to=me`. */
  filter?: string;
};

const norm = (c: ReadModelContract) => ({
  propertyScope: c.propertyScope,
  dateScope: c.dateScope,
  lifecycle: [...c.lifecycle].map((s) => s.toLowerCase()).sort(),
  filter: c.filter ?? null,
});

export type ContractMismatch = {
  field: "propertyScope" | "dateScope" | "lifecycle" | "filter";
  card: string;
  workspace: string;
};

/** Compare a card's contract with its workspace's contract. */
export function reconcileContracts(
  card: ReadModelContract,
  workspace: ReadModelContract,
): ContractMismatch[] {
  const a = norm(card);
  const b = norm(workspace);
  const out: ContractMismatch[] = [];
  if (a.propertyScope !== b.propertyScope)
    out.push({ field: "propertyScope", card: a.propertyScope, workspace: b.propertyScope });
  if (a.dateScope !== b.dateScope)
    out.push({ field: "dateScope", card: a.dateScope, workspace: b.dateScope });
  if (a.lifecycle.join(",") !== b.lifecycle.join(","))
    out.push({ field: "lifecycle", card: a.lifecycle.join(","), workspace: b.lifecycle.join(",") });
  if (a.filter !== b.filter)
    out.push({ field: "filter", card: a.filter ?? "—", workspace: b.filter ?? "—" });
  return out;
}

/**
 * Registered contracts. A card and its workspace both register here, so the
 * agreement is asserted in CI instead of discovered in production.
 */
export const READ_MODEL_CONTRACTS: Record<string, { card: ReadModelContract; workspace: ReadModelContract }> = {};

export function registerReadModel(card: ReadModelContract, workspace: ReadModelContract) {
  READ_MODEL_CONTRACTS[card.metric] = { card, workspace };
}

/** Every registered pair that does not agree. */
export function readModelDrift(): Array<{ metric: string; mismatches: ContractMismatch[] }> {
  return Object.entries(READ_MODEL_CONTRACTS)
    .map(([metric, pair]) => ({ metric, mismatches: reconcileContracts(pair.card, pair.workspace) }))
    .filter((r) => r.mismatches.length > 0);
}

// ---------------------------------------------------------------------------
// Display rules
// ---------------------------------------------------------------------------

export type MetricQuery = {
  settled: boolean;
  error?: unknown;
  value?: number | null;
};

export type MetricDisplay =
  | { kind: "loading"; label: string }
  | { kind: "error"; label: string; detail: string }
  | { kind: "value"; label: string; value: number };

/**
 * Never infer zero from an unsettled or failed query — "Loading" and
 * "Unavailable" are honest, `0` is not.
 */
export function metricDisplay(q: MetricQuery): MetricDisplay {
  if (q.error) {
    const detail = q.error instanceof Error ? q.error.message : String(q.error);
    return { kind: "error", label: "Unavailable", detail };
  }
  if (!q.settled || q.value === null || q.value === undefined) {
    return { kind: "loading", label: "Loading…" };
  }
  return { kind: "value", label: String(q.value), value: q.value };
}

export type HealthInput = {
  /** Did the exception check itself complete? */
  checked: boolean;
  /** Canonical exceptions found by that check. */
  exceptions: number;
  /** Any error raised while checking. */
  error?: unknown;
};

export type HealthDisplay = {
  tone: "clear" | "attention" | "unknown";
  label: string;
  detail: string;
};

/** Green requires a completed check AND zero canonical exceptions. */
export function healthDisplay(input: HealthInput): HealthDisplay {
  if (input.error) {
    const detail = input.error instanceof Error ? input.error.message : String(input.error);
    return { tone: "unknown", label: "Check did not complete", detail };
  }
  if (!input.checked) {
    return { tone: "unknown", label: "Not yet checked", detail: "Run the check to confirm this area." };
  }
  if (input.exceptions > 0) {
    return {
      tone: "attention",
      label: `${input.exceptions} exception${input.exceptions === 1 ? "" : "s"}`,
      detail: "Open the exception register to clear these before closing.",
    };
  }
  return { tone: "clear", label: "No exceptions", detail: "Verified against the canonical register." };
}
