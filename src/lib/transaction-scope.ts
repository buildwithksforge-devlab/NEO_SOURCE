/**
 * Canonical transaction scope.
 *
 * Every operational transaction in NEØ — a reservation assignment, a POS send,
 * a work order, a GRN, a supplier payment — carries the same immutable set of
 * facts, decided once, before anything is written:
 *
 *   organisation · property · transaction · source module · actor · status ·
 *   currency · idempotency key
 *
 * Two rules follow from that, and they are the reason this module exists
 * rather than each screen deciding for itself:
 *
 *  1. "All Properties" is a reporting scope. Reading across the estate is a
 *     legitimate, useful thing to do; writing across it is not, because the
 *     resulting record would have no property of its own. A transaction
 *     attempted in reporting scope is *blocked* — never silently posted to a
 *     guessed property, and never reported as successful.
 *
 *  2. No record from another property may participate. Cross-property
 *     participation is checked here, on the facts already loaded, so the
 *     failure is explained to the operator instead of surfacing later as an
 *     RLS error or, worse, as a posting under the wrong property.
 *
 * The idempotency key is deterministic: the same command, described the same
 * way, produces the same key. That is what makes a double-click, an impatient
 * retry and a reconnect after a dropped response converge on one transaction
 * instead of three.
 */
import { outcome, type CommandOutcome } from "./command-outcome";

export type TransactionScope = {
  organizationId: string;
  /** Exactly one property. Never "all", never null, never inferred. */
  propertyId: string;
  /** The client-side transaction identity carried into the write. */
  transactionId: string;
  sourceModule: string;
  actorId: string;
  actorName: string;
  /** Opening status of the command; the backend decides where it ends up. */
  status: "requested";
  currency: string;
  idempotencyKey: string;
};

export type ScopeInput = {
  organizationId: string | null | undefined;
  /** The global selector value: a property ID, "all", or nothing. */
  activeBranchId: string | "all" | null | undefined;
  /** Properties the backend grants this user; empty means "not yet loaded". */
  permittedBranchIds?: readonly string[];
  sourceModule: string;
  action: string;
  actorId: string | null | undefined;
  actorName?: string | null;
  currency: string | null | undefined;
  /**
   * The stable business identity of this command — the parts that make it
   * *this* transaction and not another one (order ID, folio ID, amount, room).
   * Two clicks describing the same command must produce the same parts.
   */
  identity: readonly (string | number | null | undefined)[];
};

export type ScopeResult =
  | { ok: true; scope: TransactionScope }
  | { ok: false; outcome: CommandOutcome };

export const REPORTING_SCOPE_MESSAGE =
  "All Properties is a reporting view. Select the property this transaction belongs to before continuing.";

/**
 * A small, stable, non-cryptographic digest (FNV-1a).
 *
 * It is not a security primitive; it exists so the same command description
 * always yields the same short key, in the browser, with no dependency.
 */
function digest(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Deterministic idempotency key: same command in, same key out. */
export function stableIdempotencyKey(
  module: string,
  action: string,
  parts: readonly (string | number | null | undefined)[],
): string {
  const body = parts
    .map((p) => (p === null || p === undefined ? "" : String(p).trim().toLowerCase()))
    .join("|");
  return `${module}:${action}:${digest(body)}`;
}

/**
 * The same deterministic identity, shaped as a UUID.
 *
 * Some routines type their attempt key as `uuid` rather than text. Minting a
 * fresh `randomUUID()` there would defeat the point — a double tap would look
 * like two different attempts — so the stable key is expanded into a valid
 * v4-shaped UUID instead: same command in, same UUID out.
 */
export function stableIdempotencyUuid(
  module: string,
  action: string,
  parts: readonly (string | number | null | undefined)[],
): string {
  const base = stableIdempotencyKey(module, action, parts);
  const hex = [0, 1, 2, 3]
    .map((round) => digest(`${round}:${base}`))
    .join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Resolve the scope for a command, or explain precisely why it cannot run.
 *
 * The caller must treat a blocked result as a halt: nothing is written, no
 * success tone is shown, and the reason is put in front of the operator.
 */
export function resolveTransactionScope(input: ScopeInput): ScopeResult {
  const organizationId = input.organizationId?.trim();
  if (!organizationId) {
    return {
      ok: false,
      outcome: outcome(
        "blocked",
        "No organisation is active for this session, so nothing can be recorded.",
        "no-organisation",
      ),
    };
  }

  if (!input.activeBranchId) {
    return {
      ok: false,
      outcome: outcome(
        "blocked",
        "Select the property this transaction belongs to before continuing.",
        "no-property",
      ),
    };
  }

  if (input.activeBranchId === "all") {
    return { ok: false, outcome: outcome("blocked", REPORTING_SCOPE_MESSAGE, "reporting-scope") };
  }

  const permitted = input.permittedBranchIds;
  if (permitted && permitted.length > 0 && !permitted.includes(input.activeBranchId)) {
    return {
      ok: false,
      outcome: outcome(
        "blocked",
        "You are not assigned to the selected property, so a transaction cannot be raised there.",
        "property-not-permitted",
      ),
    };
  }

  const actorId = input.actorId?.trim();
  if (!actorId) {
    return {
      ok: false,
      outcome: outcome(
        "blocked",
        "No signed-in actor could be established for this transaction.",
        "no-actor",
      ),
    };
  }

  const currency = (input.currency ?? "").trim().toUpperCase();
  if (!currency) {
    return {
      ok: false,
      outcome: outcome(
        "blocked",
        "This property has no operating currency configured, so amounts cannot be recorded.",
        "no-currency",
      ),
    };
  }

  const idempotencyKey = stableIdempotencyKey(input.sourceModule, input.action, [
    organizationId,
    input.activeBranchId,
    actorId,
    ...input.identity,
  ]);

  return {
    ok: true,
    scope: {
      organizationId,
      propertyId: input.activeBranchId,
      // The transaction identity is the idempotency key's twin: derived from
      // the same facts, so a retry is recognisably the same transaction.
      transactionId: `${input.sourceModule}-${digest(`${idempotencyKey}#txn`)}`,
      sourceModule: input.sourceModule,
      actorId,
      actorName: input.actorName?.trim() || "Unknown actor",
      status: "requested",
      currency,
      idempotencyKey,
    },
  };
}

/** The columns every scoped write carries. Never taken from a form. */
export function scopeColumns(scope: TransactionScope): {
  organization_id: string;
  branch_id: string;
  currency: string;
} {
  return {
    organization_id: scope.organizationId,
    branch_id: scope.propertyId,
    currency: scope.currency,
  };
}

export type Participant = {
  /** What the operator would call it: "Room 307", "Table 4", "Tusker 500ml". */
  label: string;
  branchId?: string | null;
  organizationId?: string | null;
};

/**
 * Refuse a transaction that would mix properties.
 *
 * A participant with no property of its own (an organisation-wide catalogue
 * item, a shared supplier) is allowed through: it belongs to the estate, not
 * to a rival property. A participant belonging to a *different* property is a
 * hard block, named so the operator can see which record is wrong.
 */
export function assertSameProperty(
  scope: TransactionScope,
  participants: readonly Participant[],
): CommandOutcome | null {
  const foreign = participants.filter(
    (p) =>
      (p.branchId && p.branchId !== scope.propertyId) ||
      (p.organizationId && p.organizationId !== scope.organizationId),
  );
  if (foreign.length === 0) return null;
  const names = foreign.map((p) => p.label).join(", ");
  return outcome(
    "blocked",
    `${names} ${foreign.length === 1 ? "belongs" : "belong"} to another property and cannot take part in this transaction.`,
    "cross-property-participant",
  );
}
