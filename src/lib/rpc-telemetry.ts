/**
 * RPC session guard + call telemetry.
 *
 * Two failure modes were reaching users as empty screens rather than as an
 * honest message:
 *
 *  1. A database routine declared `authenticated` in the RPC manifest was
 *     reached while the browser held no (or an expired) session, so Postgres
 *     answered "permission denied for function …" and the screen simply
 *     rendered nothing.
 *  2. A genuine authorisation denial was indistinguishable, in the UI, from
 *     "there is no data".
 *
 * `invokeRpc` closes both: it refuses to call an authenticated routine as
 * `anon`, classifies permission denials, and records one structured metric per
 * call — including the executing role — so monitoring can separate an
 * anonymous call storm from a real grant problem.
 */

import { supabase } from "@/integrations/supabase/client";
import { RPC_MANIFEST, type RpcCaller } from "@/lib/rpc-manifest";
import {
  newCorrelationId,
  recordActionSpan,
  RELEASE,
  type ActionClass,
  type ActionOutcome,
} from "@/lib/perf-telemetry";

export type RpcExecutingRole = "anon" | "authenticated" | "unknown";

export type RpcOutcome = "ok" | "auth_required" | "permission_denied" | "error";

export type RpcCallMetric = {
  /** Database routine name. */
  rpc: string;
  /** Lowest role allowed to execute it, from the callable-surface manifest. */
  required: RpcCaller;
  /** Role the browser actually executed as. */
  role: RpcExecutingRole;
  outcome: RpcOutcome;
  durationMs: number;
  code: string | null;
  message: string | null;
  at: number;
};

/** Message shown whenever the only honest remedy is to sign in again. */
export const REAUTH_MESSAGE =
  "Your session is no longer authorised. Sign in again to continue.";

/**
 * Raised instead of silently returning an empty list when a routine cannot be
 * executed by the current session.
 */
export class RpcAccessError extends Error {
  readonly rpc: string;
  readonly reason: "no-session" | "permission-denied";
  /** Always true: both reasons are resolved by signing in again. */
  readonly requiresReauth = true;

  constructor(rpc: string, reason: "no-session" | "permission-denied", message?: string) {
    super(message ?? REAUTH_MESSAGE);
    this.name = "RpcAccessError";
    this.rpc = rpc;
    this.reason = reason;
  }
}

export function isRpcAccessError(error: unknown): error is RpcAccessError {
  return error instanceof RpcAccessError;
}

type ErrorLike = { code?: string | null; message?: string | null; details?: string | null } | null | undefined;

/** Postgres 42501, plus the textual form PostgREST surfaces for routines. */
export function isPermissionDeniedError(error: ErrorLike): boolean {
  if (!error) return false;
  if (error.code === "42501") return true;
  const text = `${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  return text.includes("permission denied") || text.includes("jwt expired");
}

/** True when the failure means "sign in again", from any error shape. */
export function requiresReauthentication(error: unknown): boolean {
  if (isRpcAccessError(error)) return true;
  if (error instanceof Error) return isPermissionDeniedError({ message: error.message });
  return isPermissionDeniedError(error as ErrorLike);
}

/* ------------------------------------------------------------------ metrics */

const METRIC_LIMIT = 200;
const metrics: RpcCallMetric[] = [];
type Listener = (metric: RpcCallMetric) => void;
const listeners = new Set<Listener>();

export function onRpcMetric(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Most recent calls, newest first. Read by the administration monitor. */
export function getRpcMetrics(): RpcCallMetric[] {
  return [...metrics].reverse();
}

/** Test-only. */
export function resetRpcTelemetry() {
  metrics.length = 0;
  listeners.clear();
}

/**
 * Which acceptance target a routine is judged against.
 *
 * Money and stock crossing a line get the critical-transaction budget; a write
 * gets the routine-save budget; everything else is a read.
 */
export function rpcActionClass(rpc: string): ActionClass {
  if (CRITICAL_MONITORED_RPCS.has(rpc)) return "critical";
  if (/(settle|pay|post|receive|grn|checkout|refund|close|issue|deduct)/.test(rpc)) {
    return "critical";
  }
  if (/(create|save|update|apply|record|assign|approve|start|complete|adjust)/.test(rpc)) {
    return "save";
  }
  return "read";
}

function outcomeToAction(outcome: RpcOutcome): ActionOutcome {
  if (outcome === "ok") return "ok";
  if (outcome === "auth_required" || outcome === "permission_denied") return "rejected";
  return "failed";
}

export function recordRpcMetric(metric: RpcCallMetric) {
  metrics.push(metric);
  if (metrics.length > METRIC_LIMIT) metrics.shift();

  // Same call, seen as an action with an acceptance target attached.
  recordActionSpan({
    action: metric.rpc,
    kind: rpcActionClass(metric.rpc),
    correlationId: newCorrelationId(),
    propertyId: null,
    release: RELEASE,
    durationMs: metric.durationMs,
    outcome: outcomeToAction(metric.outcome),
    retries: 0,
    at: metric.at,
  });

  if (metric.outcome !== "ok") {
    // Structured single-line record so log search can group by rpc + role.
    // eslint-disable-next-line no-console
    console.error(
      `[rpc-telemetry] ${metric.rpc} ${metric.outcome} as ${metric.role}`,
      {
        rpc: metric.rpc,
        required: metric.required,
        role: metric.role,
        outcome: metric.outcome,
        durationMs: metric.durationMs,
        code: metric.code,
      },
    );
  }

  for (const listener of listeners) {
    try {
      listener(metric);
    } catch {
      /* a telemetry sink must never break an operational call */
    }
  }
}

/** Aggregate view for the monitoring panel: one row per rpc + executing role. */
export type RpcMetricSummary = {
  rpc: string;
  role: RpcExecutingRole;
  calls: number;
  failures: number;
  anonCalls: number;
  lastOutcome: RpcOutcome;
  lastAt: number;
};

export function summariseRpcMetrics(rows: RpcCallMetric[] = getRpcMetrics()): RpcMetricSummary[] {
  const map = new Map<string, RpcMetricSummary>();
  for (const row of rows) {
    const key = `${row.rpc}::${row.role}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        rpc: row.rpc,
        role: row.role,
        calls: 1,
        failures: row.outcome === "ok" ? 0 : 1,
        anonCalls: row.role === "anon" ? 1 : 0,
        lastOutcome: row.outcome,
        lastAt: row.at,
      });
      continue;
    }
    existing.calls += 1;
    if (row.outcome !== "ok") existing.failures += 1;
    if (row.role === "anon") existing.anonCalls += 1;
    if (row.at >= existing.lastAt) {
      existing.lastAt = row.at;
      existing.lastOutcome = row.outcome;
    }
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/* -------------------------------------------------------------------- guard */

export function requiredCallerFor(rpc: string): RpcCaller {
  return RPC_MANIFEST[rpc] ?? "authenticated";
}

/** Resolve the role the next call would execute as, from the live session. */
export async function resolveExecutingRole(): Promise<RpcExecutingRole> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ? "authenticated" : "anon";
  } catch {
    return "unknown";
  }
}

type RpcResult<T> = { data: T | null; error: ErrorLike };

/**
 * Execute a database routine with a session guard and one structured metric.
 *
 * A routine the manifest declares as `authenticated` is never dispatched while
 * the browser is anonymous — the call is refused locally, so monitoring shows a
 * client-side `auth_required` instead of a server-side permission denial, and
 * the user is told to sign in again rather than shown an empty screen.
 */
export async function invokeRpc<T>(
  rpc: string,
  run: () => Promise<RpcResult<T>>,
): Promise<T> {
  const required = requiredCallerFor(rpc);
  const role = await resolveExecutingRole();
  const started = Date.now();

  if (required !== "anon" && role !== "authenticated") {
    recordRpcMetric({
      rpc,
      required,
      role,
      outcome: "auth_required",
      durationMs: 0,
      code: "no_session",
      message: "No authenticated session; call not dispatched.",
      at: started,
    });
    throw new RpcAccessError(rpc, "no-session");
  }

  const { data, error } = await run();
  const durationMs = Date.now() - started;

  if (error) {
    const denied = isPermissionDeniedError(error);
    recordRpcMetric({
      rpc,
      required,
      role,
      outcome: denied ? "permission_denied" : "error",
      durationMs,
      code: error.code ?? null,
      message: error.message ?? null,
      at: started,
    });
    if (denied) throw new RpcAccessError(rpc, "permission-denied");
    throw new Error(error.message ?? `${rpc} failed.`);
  }

  recordRpcMetric({
    rpc,
    required,
    role,
    outcome: "ok",
    durationMs,
    code: null,
    message: null,
    at: started,
  });
  return data as T;
}

/* ------------------------------------------------------- export + alerting */

/** Metrics inside a time window, newest first. `windowMs = 0` means all. */
export function rpcMetricsWithin(windowMs: number, now = Date.now()): RpcCallMetric[] {
  const rows = getRpcMetrics();
  if (!windowMs) return rows;
  return rows.filter((r) => now - r.at <= windowMs);
}

/** CSV of routine call outcomes and durations, for a downloaded audit trail. */
export function rpcMetricsCsv(rows: RpcCallMetric[]): string {
  const header = "timestamp,routine,required_role,executing_role,outcome,duration_ms,code,message";
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      new Date(r.at).toISOString(),
      r.rpc,
      r.required,
      r.role,
      r.outcome,
      String(r.durationMs),
      r.code ?? "",
      (r.message ?? "").replace(/\s+/g, " "),
    ]
      .map(escape)
      .join(","),
  );
  return [header, ...lines].join("\n");
}

export type RpcSpikeAlert = {
  rpc: string;
  role: RpcExecutingRole;
  /** Denials of authority plus refused anonymous calls in the window. */
  denials: number;
  windowMs: number;
  firstAt: number;
  lastAt: number;
  message: string;
};

/**
 * Raise one alert per routine + role whose permission-denied / re-auth-required
 * failures cross the threshold inside the window. A single denial is ordinary
 * (an expired tab); a cluster means a grant or a role template is wrong and an
 * administrator has to look.
 */
export function detectRpcSpikes(
  rows: RpcCallMetric[] = getRpcMetrics(),
  { windowMs = 5 * 60_000, threshold = 3, now = Date.now() } = {},
): RpcSpikeAlert[] {
  const buckets = new Map<string, RpcCallMetric[]>();
  for (const row of rows) {
    if (row.outcome !== "permission_denied" && row.outcome !== "auth_required") continue;
    if (windowMs && now - row.at > windowMs) continue;
    const key = `${row.rpc}::${row.role}`;
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }

  const alerts: RpcSpikeAlert[] = [];
  for (const list of buckets.values()) {
    if (list.length < threshold) continue;
    const times = list.map((r) => r.at);
    const first = list[0]!;
    alerts.push({
      rpc: first.rpc,
      role: first.role,
      denials: list.length,
      windowMs,
      firstAt: Math.min(...times),
      lastAt: Math.max(...times),
      message: `${list.length} authorisation failures on ${first.rpc} as ${first.role} in the last ${Math.round(
        windowMs / 60_000,
      )} minutes.`,
    });
  }
  return alerts.sort((a, b) => b.denials - a.denials);
}

/* --------------------------------------------- critical-routine monitoring */

/**
 * Routines where a refused or denied call means money or a live delivery is
 * affected. Any access failure on these is alerted immediately — no threshold,
 * no window — because one silent failure is already an operational incident.
 */
export const CRITICAL_MONITORED_RPCS = new Set<string>([
  "neo_mpesa_apply_result",
  "neo_mpesa_txn_start",
  "neo_mpesa_can_collect",
  "neo_mpesa_record_check",
  "neo_pos_settle_order",
  "neo_delivery_assign",
  "neo_delivery_dispatch_candidates",
  "neo_delivery_rider_directory",
  "neo_delivery_rider_candidates",
  "neo_delivery_rider_roster",
  "neo_delivery_notification_audit",
]);

export type CriticalRpcAlert = {
  rpc: string;
  role: RpcExecutingRole;
  outcome: Extract<RpcOutcome, "auth_required" | "permission_denied">;
  at: number;
  /** "payment" or "delivery" — what the failure blocks. */
  area: "payment" | "delivery";
  message: string;
};

function areaFor(rpc: string): "payment" | "delivery" {
  return rpc.includes("mpesa") || rpc.includes("settle") ? "payment" : "delivery";
}

/** Access failures on critical payment/delivery routines, newest first. */
export function criticalRpcAlerts(rows: RpcCallMetric[] = getRpcMetrics()): CriticalRpcAlert[] {
  const alerts: CriticalRpcAlert[] = [];
  for (const row of rows) {
    if (!CRITICAL_MONITORED_RPCS.has(row.rpc)) continue;
    if (row.outcome !== "auth_required" && row.outcome !== "permission_denied") continue;
    const area = areaFor(row.rpc);
    alerts.push({
      rpc: row.rpc,
      role: row.role,
      outcome: row.outcome,
      at: row.at,
      area,
      message:
        row.outcome === "auth_required"
          ? `${row.rpc} was refused before dispatch (no authorised session) — ${area} work is blocked.`
          : `${row.rpc} was denied by the database as ${row.role} — ${area} work is blocked.`,
    });
  }
  return alerts.sort((a, b) => b.at - a.at);
}

/**
 * Subscribe to critical access failures as they happen. Used by the
 * administration monitor to raise an alert the moment a payment or delivery
 * routine is refused, rather than when someone reads the logs.
 */
export function onCriticalRpcFailure(listener: (alert: CriticalRpcAlert) => void): () => void {
  return onRpcMetric((metric) => {
    const [alert] = criticalRpcAlerts([metric]);
    if (alert) listener(alert);
  });
}

