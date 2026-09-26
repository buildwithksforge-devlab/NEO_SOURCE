/**
 * NEØ launch coordinator.
 *
 * One canonical state machine for the branded opening frame. The launch shell
 * (see launch-splash.ts) is painted by the server-rendered document; this
 * module decides when it may leave. It may only leave once the real
 * destination has rendered a stable frame — never merely because the bundle
 * downloaded or React mounted.
 *
 *   cold-start → restoring-session → resolving-context → ready
 *                                                      ↘ recoverable-error
 *                                                      ↘ offline
 */

export type LaunchState =
  | "cold-start"
  | "restoring-session"
  | "resolving-context"
  | "ready"
  | "recoverable-error"
  | "offline";

export type LaunchMarks = {
  shellPaintedAt: number | null;
  bundleStartedAt: number | null;
  appMountedAt: number | null;
  sessionResolvedAt: number | null;
  contextResolvedAt: number | null;
  destinationPaintedAt: number | null;
  splashRemovedAt: number | null;
  destination: string | null;
  coldOrWarmStart: "cold" | "warm" | null;
  offlineState: boolean;
  buildVersion: string | null;
  state: LaunchState;
};

type LaunchGlobal = {
  neoLaunchDone?: () => void;
  neoLaunchMarks?: Partial<LaunchMarks>;
  __neoLaunch?: LaunchMarks & { warnings: string[] };
};

const DEFAULTS: LaunchMarks = {
  shellPaintedAt: null,
  bundleStartedAt: null,
  appMountedAt: null,
  sessionResolvedAt: null,
  contextResolvedAt: null,
  destinationPaintedAt: null,
  splashRemovedAt: null,
  destination: null,
  coldOrWarmStart: null,
  offlineState: false,
  buildVersion: null,
  state: "cold-start",
};

function globalRef(): LaunchGlobal | null {
  if (typeof window === "undefined") return null;
  return window as unknown as LaunchGlobal;
}

/** Diagnostics record. Always readable; only surfaced in the diagnostics area. */
export function launchDiagnostics(): LaunchMarks & { warnings: string[] } {
  const g = globalRef();
  if (!g) return { ...DEFAULTS, warnings: [] };
  if (!g.__neoLaunch) {
    g.__neoLaunch = { ...DEFAULTS, ...(g.neoLaunchMarks ?? {}), warnings: [] };
  }
  return g.__neoLaunch;
}

export function markLaunch(patch: Partial<LaunchMarks>): void {
  const record = launchDiagnostics();
  Object.assign(record, patch);
}

export function setLaunchState(state: LaunchState): void {
  markLaunch({ state });
}

/**
 * The only place the launch shell is dismissed. Callers must have observed a
 * painted destination frame first.
 */
export function completeLaunch(destination: string): void {
  const g = globalRef();
  if (!g) return;
  const now = Math.round(performance.now());
  markLaunch({
    destination,
    destinationPaintedAt: now,
    state: "ready",
  });
  const done = g.neoLaunchDone;
  if (typeof done === "function") {
    done();
    markLaunch({ splashRemovedAt: Math.round(performance.now()) });
  }
  if (import.meta.env.DEV) auditLaunch();
}

/** Development-only flags for the diagnostics area. */
export function auditLaunch(): string[] {
  const record = launchDiagnostics();
  const warnings: string[] = [];
  const { shellPaintedAt, destinationPaintedAt, splashRemovedAt, sessionResolvedAt } = record;

  if (splashRemovedAt != null && destinationPaintedAt != null && splashRemovedAt < destinationPaintedAt) {
    warnings.push("Launch shell was removed before the destination painted.");
  }
  if (shellPaintedAt == null) {
    warnings.push("Static launch shell never reported a paint — white-frame risk.");
  }
  if (destinationPaintedAt != null && destinationPaintedAt > 6000) {
    warnings.push("Launch shell stayed visible for more than 6s.");
  }
  if (sessionResolvedAt != null && sessionResolvedAt > 5000) {
    warnings.push("Session restoration exceeded 5s.");
  }
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    warnings.push("Launched offline — offline entry shell in use.");
  }
  record.warnings = warnings;
  return warnings;
}
