/**
 * Action performance telemetry.
 *
 * A single request's duration says little: a screen that makes ten quick calls
 * in sequence still feels slow. So the unit recorded here is the *action* a
 * person takes — "post payroll", "settle order", "receive goods" — measured
 * from the click to the moment the screen can honestly show the committed
 * result, with a correlation id that ties the client span to the server call.
 *
 * Nothing identifying is recorded: no guest names, no PINs, no payment
 * references, no free-text. Only the action name, the property scope, timings
 * and an outcome class.
 */

export type ActionClass =
  /** Reading a record or list: order, room, stock lookup. */
  | "read"
  /** Saving ordinary work: an item, a task, a reservation draft. */
  | "save"
  /** Money or stock crossing a line: payment, GRN, checkout. */
  | "critical"
  /** A committed change arriving on another staff screen. */
  | "propagation";

export type ActionOutcome = "ok" | "rejected" | "failed" | "timeout";

export type ActionSpan = {
  /** Stable action name, e.g. "pos.settle_order". Never free text from a user. */
  action: string;
  kind: ActionClass;
  /** Ties this span to the server call and to the audit trail. */
  correlationId: string;
  /** Property the action belonged to, or null for workspace-wide work. */
  propertyId: string | null;
  /** Release the browser is running, so a regression can be attributed. */
  release: string;
  durationMs: number;
  outcome: ActionOutcome;
  /** How many times the client retried before this result. */
  retries: number;
  at: number;
};

/** Acceptance targets, in milliseconds at p95. */
export const ACTION_TARGET_MS: Record<ActionClass, number> = {
  read: 500,
  save: 800,
  critical: 1500,
  propagation: 1000,
};

/** p99 targets, where one is separately agreed. */
export const ACTION_TARGET_P99_MS: Partial<Record<ActionClass, number>> = {
  propagation: 3000,
};

const LIMIT = 500;
const spans: ActionSpan[] = [];
type Listener = (span: ActionSpan) => void;
const listeners = new Set<Listener>();

export const RELEASE =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, string | undefined> }).env?.["VITE_RELEASE"]) ||
  "dev";

export function newCorrelationId(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function onActionSpan(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recordActionSpan(span: ActionSpan) {
  spans.push(span);
  if (spans.length > LIMIT) spans.shift();
  for (const listener of listeners) {
    try {
      listener(span);
    } catch {
      /* telemetry must never break an operational action */
    }
  }
}

/** Recorded spans, newest first. */
export function getActionSpans(): ActionSpan[] {
  return [...spans].reverse();
}

/** Test-only. */
export function resetActionSpans() {
  spans.length = 0;
  listeners.clear();
}

/**
 * Time one action end to end.
 *
 * The span is recorded when the promise settles, so the duration always covers
 * the committed result rather than the moment the button was pressed. A
 * rejection is classified rather than swallowed, and the original error is
 * rethrown untouched.
 */
export async function measureAction<T>(
  action: string,
  kind: ActionClass,
  run: (correlationId: string) => Promise<T>,
  options: { propertyId?: string | null; retries?: number } = {},
): Promise<T> {
  const correlationId = newCorrelationId();
  const started = Date.now();
  const finish = (outcome: ActionOutcome) =>
    recordActionSpan({
      action,
      kind,
      correlationId,
      propertyId: options.propertyId ?? null,
      release: RELEASE,
      durationMs: Date.now() - started,
      outcome,
      retries: options.retries ?? 0,
      at: started,
    });

  try {
    const result = await run(correlationId);
    finish("ok");
    return result;
  } catch (error) {
    finish(classifyOutcome(error));
    throw error;
  }
}

/** A validation refusal is a correct answer, not a fault; it is counted apart. */
export function classifyOutcome(error: unknown): ActionOutcome {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (
    message.includes("not allowed") ||
    message.includes("must be") ||
    message.includes("already") ||
    message.includes("required") ||
    message.includes("invalid")
  ) {
    return "rejected";
  }
  return "failed";
}

/* ------------------------------------------------------------- percentiles */

/** Nearest-rank percentile, so the reported figure is a value that occurred. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

export type ActionSummary = {
  action: string;
  kind: ActionClass;
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  failures: number;
  rejections: number;
  timeouts: number;
  retries: number;
  /** p95 target for this action's class. */
  targetMs: number;
  /** True when p95 sits above the agreed target. */
  breaching: boolean;
  lastAt: number;
};

export function summariseActions(rows: ActionSpan[] = getActionSpans()): ActionSummary[] {
  const groups = new Map<string, ActionSpan[]>();
  for (const row of rows) {
    const list = groups.get(row.action);
    if (list) list.push(row);
    else groups.set(row.action, [row]);
  }

  const out: ActionSummary[] = [];
  for (const list of groups.values()) {
    const first = list[0]!;
    // Only successful work is timed against the target: a rejection is fast
    // for the wrong reason and would flatter the figures.
    const durations = list.filter((r) => r.outcome === "ok").map((r) => r.durationMs);
    const p95 = percentile(durations, 95);
    const targetMs = ACTION_TARGET_MS[first.kind];
    out.push({
      action: first.action,
      kind: first.kind,
      samples: list.length,
      p50: percentile(durations, 50),
      p95,
      p99: percentile(durations, 99),
      worst: durations.length ? Math.max(...durations) : 0,
      failures: list.filter((r) => r.outcome === "failed").length,
      rejections: list.filter((r) => r.outcome === "rejected").length,
      timeouts: list.filter((r) => r.outcome === "timeout").length,
      retries: list.reduce((t, r) => t + r.retries, 0),
      targetMs,
      breaching: durations.length > 0 && p95 > targetMs,
      lastAt: Math.max(...list.map((r) => r.at)),
    });
  }
  return out.sort((a, b) => b.p95 - a.p95);
}

/** CSV of the raw spans, for the before/after release report. */
export function actionSpansCsv(rows: ActionSpan[] = getActionSpans()): string {
  const header =
    "timestamp,action,class,correlation_id,property,release,duration_ms,outcome,retries";
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      new Date(r.at).toISOString(),
      r.action,
      r.kind,
      r.correlationId,
      r.propertyId ?? "",
      r.release,
      String(r.durationMs),
      r.outcome,
      String(r.retries),
    ]
      .map(escape)
      .join(","),
  );
  return [header, ...lines].join("\n");
}
