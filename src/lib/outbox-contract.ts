/**
 * The one durable handoff mechanism.
 *
 * Cross-module consequences in NEØ are not fire-and-forget calls made from a
 * button handler. They are durable events on `public.domain_events`: written
 * in the same breath as the business record, retried on their own schedule,
 * and replayable by a named authority when they fail for good.
 *
 * This module is the contract those events answer to. It names the handoffs
 * the operating system depends on, states what a usable event record must
 * carry, and gives every screen one vocabulary for describing an event's
 * position — so a stalled checkout-to-housekeeping handoff and a stalled
 * GRN-to-Finance handoff read the same way and are recovered the same way.
 *
 * It deliberately holds no queries. Reading and replaying live in the data
 * layer (`finance-posting.ts`, `platform.ts`); what is canonical here is the
 * shape of the promise.
 */

export type HandoffKey =
  | "checkout.housekeeping"
  | "pos.kds"
  | "pos.inventory"
  | "revenue.finance"
  | "deposit.finance"
  | "grn.finance"
  | "supplier_payment.journal"
  | "maintenance.availability"
  | "night_audit.close_day";

export type HandoffDefinition = {
  key: HandoffKey;
  label: string;
  /** Plain-language statement of the consequence this handoff guarantees. */
  promise: string;
  /** Module that raises the event. */
  source: string;
  /** Module that consumes it. */
  downstream: string;
  /** Event types observed on this path. */
  eventTypes: readonly string[];
  /** Permission a replay requires — recovery is an authority, not a button. */
  replayPermission: { module: string; action: string };
};

export const HANDOFFS: readonly HandoffDefinition[] = [
  {
    key: "checkout.housekeeping",
    label: "Checkout → Housekeeping",
    promise: "A departed room becomes a cleaning job and stops being sellable until it is ready.",
    source: "pms",
    downstream: "housekeeping",
    eventTypes: [
      "stay.checked_out",
      "reservation.checked-out",
      "housekeeping.room.released",
      "housekeeping.task.created",
    ],
    replayPermission: { module: "housekeeping", action: "edit" },
  },
  {
    key: "pos.kds",
    label: "POS → Kitchen",
    promise: "A sent order reaches the station screen that must cook it.",
    source: "pos",
    downstream: "kitchen",
    eventTypes: ["order.created", "pos.ticket_routed", "kitchen.order.ready", "order.delayed"],
    replayPermission: { module: "kitchen", action: "edit" },
  },
  {
    key: "pos.inventory",
    label: "POS → Inventory",
    promise: "A sold item consumes its recipe from the issuing store exactly once.",
    source: "pos",
    downstream: "inventory",
    eventTypes: ["pos.consumption.recorded", "inventory.consumed"],
    replayPermission: { module: "inventory", action: "edit" },
  },
  {
    key: "revenue.finance",
    label: "POS / folio / payment → Finance",
    promise: "Revenue and settlement reach the ledger as balanced journals, once.",
    source: "pos",
    downstream: "finance",
    eventTypes: ["finance.posted", "payment.confirmed", "folio.room_charge_posted", "pos.room_charge.posted"],
    replayPermission: { module: "finance", action: "edit" },
  },
  {
    key: "deposit.finance",
    label: "Deposit → Finance",
    promise: "A pre-arrival deposit is held as a liability until the stay earns it.",
    source: "pms",
    downstream: "finance",
    eventTypes: ["deposit.recorded", "finance.posted"],
    replayPermission: { module: "finance", action: "edit" },
  },
  {
    key: "grn.finance",
    label: "GRN → Finance",
    promise: "Accepted goods recognise inventory and accrue GRNI before any invoice arrives.",
    source: "procurement",
    downstream: "finance",
    eventTypes: ["grn.accepted", "inventory.recognised", "finance.posted"],
    replayPermission: { module: "finance", action: "edit" },
  },
  {
    key: "supplier_payment.journal",
    label: "Supplier payment → Journal",
    promise: "A released payment clears the payable and lands in the general ledger.",
    source: "finance",
    downstream: "finance",
    eventTypes: ["supplier_payment.released", "finance.posted"],
    replayPermission: { module: "finance", action: "edit" },
  },
  {
    key: "maintenance.availability",
    label: "Maintenance → Room availability",
    promise: "A room blocked for repair leaves the sellable inventory and returns when cleared.",
    source: "maintenance",
    downstream: "pms",
    eventTypes: ["maintenance.room.blocked", "maintenance.room.released", "room.state_changed"],
    replayPermission: { module: "maintenance", action: "edit" },
  },
  {
    key: "night_audit.close_day",
    label: "Night Audit → Close day",
    promise: "The business date only rolls once the audit has run and nothing blocking remains.",
    source: "finance",
    downstream: "finance",
    eventTypes: ["night_audit.completed", "business_day.closed"],
    replayPermission: { module: "finance", action: "approve" },
  },
];

const BY_EVENT_TYPE = new Map<string, HandoffKey[]>();
for (const handoff of HANDOFFS) {
  for (const type of handoff.eventTypes) {
    BY_EVENT_TYPE.set(type, [...(BY_EVENT_TYPE.get(type) ?? []), handoff.key]);
  }
}

/** The raw shape read back from `domain_events`. */
export type OutboxEventRow = {
  id?: string | null;
  event_type?: string | null;
  source_module?: string | null;
  source_record_id?: string | null;
  branch_id?: string | null;
  organization_id?: string | null;
  status?: string | null;
  attempts?: number | null;
  retry_count?: number | null;
  max_attempts?: number | null;
  last_error?: string | null;
  next_attempt_at?: string | null;
  processed_at?: string | null;
  dead_lettered_at?: string | null;
  idempotency_key?: string | null;
  payload?: Record<string, unknown> | null;
  occurred_at?: string | null;
};

/**
 * Which handoff an event belongs to.
 *
 * Several handoffs share the generic `finance.posted` type, so the source
 * module disambiguates; an event that matches nothing is not forced into a
 * bucket — an unclassified handoff is a real finding, not a rounding error.
 */
export function classifyHandoff(row: OutboxEventRow): HandoffKey | null {
  const candidates = BY_EVENT_TYPE.get(String(row.event_type ?? "")) ?? [];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;
  const source = String(row.source_module ?? "").toLowerCase();
  const byModule = candidates.find((key) => {
    const def = HANDOFFS.find((h) => h.key === key)!;
    return source.includes(def.source) || source.includes(def.downstream);
  });
  // Source-specific naming wins where it exists, e.g. deposits and GRNs both
  // emit finance.posted but name their own module.
  const bySourceHint = candidates.find((key) => {
    if (key === "supplier_payment.journal") return source.includes("supplier_payment");
    if (key === "deposit.finance") return source.includes("deposit");
    if (key === "grn.finance")
      return (
        source.includes("grn") ||
        source.includes("inventory") ||
        (source.includes("invoice") && !source.includes("guest"))
      );
    return false;
  });
  return bySourceHint ?? byModule ?? candidates[0] ?? null;
}

export type OutboxPhase = "pending" | "retrying" | "processed" | "dead" | "unknown";

export function outboxPhase(row: OutboxEventRow): OutboxPhase {
  if (row.dead_lettered_at) return "dead";
  const status = String(row.status ?? "").toLowerCase();
  if (row.processed_at || status === "processed" || status === "completed") return "processed";
  if (status === "failed" || status === "error" || (row.attempts ?? 0) > 0) return "retrying";
  if (status === "pending" || status === "queued" || status === "processing") return "pending";
  return "unknown";
}

/** Fields an event must carry before it can be recovered by a human. */
export const REQUIRED_EVENT_FIELDS = [
  "source_record_id",
  "event_type",
  "branch_id",
  "attempts",
  "status",
  "last_error",
  "next_attempt_at",
  "idempotency_key",
  "downstream_reference",
] as const;

export type RequiredEventField = (typeof REQUIRED_EVENT_FIELDS)[number];

/**
 * The downstream record an event produced, if it produced one.
 *
 * Handlers record it on the payload; a processed event without one is a
 * handoff that claims completion with nothing to show for it.
 */
export function downstreamReference(row: OutboxEventRow): string | null {
  const payload = row.payload ?? {};
  for (const key of [
    "downstream_reference",
    "downstream_id",
    "result_id",
    "journal_id",
    "task_id",
    "ticket_id",
    "posting_id",
  ]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * Which required facts this event cannot answer.
 *
 * `last_error` and `next_attempt_at` are only required of an event that has
 * actually failed — a first-attempt pending event legitimately has neither.
 * A downstream reference is only required once an event claims to be done.
 */
export function missingRequiredFields(row: OutboxEventRow): RequiredEventField[] {
  const phase = outboxPhase(row);
  const missing: RequiredEventField[] = [];
  if (!row.source_record_id) missing.push("source_record_id");
  if (!row.event_type) missing.push("event_type");
  if (!row.branch_id) missing.push("branch_id");
  if (row.attempts === null || row.attempts === undefined) missing.push("attempts");
  if (!row.status) missing.push("status");
  if (!row.idempotency_key) missing.push("idempotency_key");
  if (phase === "retrying" || phase === "dead") {
    if (!row.last_error) missing.push("last_error");
    if (phase === "retrying" && !row.next_attempt_at) missing.push("next_attempt_at");
  }
  if (phase === "processed" && !downstreamReference(row)) missing.push("downstream_reference");
  return missing;
}

export type HandoffView = {
  handoff: HandoffDefinition | null;
  phase: OutboxPhase;
  /** One sentence an operator can act on. */
  summary: string;
  attempts: number;
  lastError: string | null;
  nextRetry: string | null;
  downstream: string | null;
  /** Replay is only offered when the event is genuinely stuck. */
  replayable: boolean;
  replayPermission: { module: string; action: string } | null;
  missing: RequiredEventField[];
};

export function describeHandoff(row: OutboxEventRow): HandoffView {
  const key = classifyHandoff(row);
  const handoff = HANDOFFS.find((h) => h.key === key) ?? null;
  const phase = outboxPhase(row);
  const attempts = Number(row.attempts ?? row.retry_count ?? 0);
  const downstream = downstreamReference(row);
  const label = handoff?.label ?? String(row.event_type ?? "Unclassified handoff");

  const summary =
    phase === "processed"
      ? `${label} completed${downstream ? ` — ${downstream}` : ""}.`
      : phase === "dead"
        ? `${label} gave up after ${attempts} attempt${attempts === 1 ? "" : "s"} and needs a manual replay.`
        : phase === "retrying"
          ? `${label} failed and will be retried${row.next_attempt_at ? ` at ${row.next_attempt_at}` : ""}.`
          : phase === "pending"
            ? `${label} is queued and has not run yet.`
            : `${label} is in an unrecognised state and should be inspected.`;

  return {
    handoff,
    phase,
    summary,
    attempts,
    lastError: row.last_error ?? null,
    nextRetry: row.next_attempt_at ?? null,
    downstream,
    replayable: phase === "dead" || phase === "retrying",
    replayPermission: handoff?.replayPermission ?? null,
    missing: missingRequiredFields(row),
  };
}

export type OutboxHealth = {
  total: number;
  pending: number;
  retrying: number;
  dead: number;
  processed: number;
  /** Handoffs with nothing in flight and nothing processed — never observed. */
  unobserved: HandoffKey[];
  /** Events that cannot be recovered because a required fact is missing. */
  incomplete: number;
};

export function outboxHealth(rows: readonly OutboxEventRow[]): OutboxHealth {
  const seen = new Set<HandoffKey>();
  let pending = 0;
  let retrying = 0;
  let dead = 0;
  let processed = 0;
  let incomplete = 0;
  for (const row of rows) {
    const key = classifyHandoff(row);
    if (key) seen.add(key);
    switch (outboxPhase(row)) {
      case "pending":
        pending += 1;
        break;
      case "retrying":
        retrying += 1;
        break;
      case "dead":
        dead += 1;
        break;
      case "processed":
        processed += 1;
        break;
      default:
        break;
    }
    if (missingRequiredFields(row).length > 0) incomplete += 1;
  }
  return {
    total: rows.length,
    pending,
    retrying,
    dead,
    processed,
    unobserved: HANDOFFS.map((h) => h.key).filter((k) => !seen.has(k)),
    incomplete,
  };
}
