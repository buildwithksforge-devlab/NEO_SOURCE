/**
 * Re-run the last action that failed for want of a session.
 *
 * Dispatching a rider is a two-minute-old decision by the time a stale session
 * is discovered; making the operator rebuild it after signing in loses the
 * decision. An action that fails with an authorisation error registers itself
 * here, and the next successful sign-in replays exactly that one action.
 *
 * Only the most recent failure per key is kept: replaying a queue of stale
 * dispatches would be worse than replaying none.
 */

import { requiresReauthentication } from "@/lib/rpc-telemetry";

export type PendingAction = {
  key: string;
  /** Shown to the operator, e.g. "Assign rider to DEL-1042". */
  label: string;
  run: () => Promise<unknown> | unknown;
  at: number;
};

const pending = new Map<string, PendingAction>();
type Listener = (actions: PendingAction[]) => void;
const listeners = new Set<Listener>();

function publish() {
  const snapshot = listPendingActions();
  for (const l of listeners) {
    try {
      l(snapshot);
    } catch {
      /* a listener must never break a retry */
    }
  }
}

export function listPendingActions(): PendingAction[] {
  return [...pending.values()].sort((a, b) => b.at - a.at);
}

export function onPendingActions(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function rememberFailedAction(action: Omit<PendingAction, "at">) {
  pending.set(action.key, { ...action, at: Date.now() });
  publish();
}

export function forgetFailedAction(key: string) {
  if (pending.delete(key)) publish();
}

export function clearPendingActions() {
  pending.clear();
  publish();
}

/**
 * Remember `action` only when `error` is an authorisation failure — an ordinary
 * business rejection ("that rider is off shift") must never be silently
 * replayed later.
 */
export function rememberIfReauthNeeded(error: unknown, action: Omit<PendingAction, "at">): boolean {
  if (!requiresReauthentication(error)) return false;
  rememberFailedAction(action);
  return true;
}

/** Replay every remembered action once, oldest decision first. */
export async function replayPendingActions(): Promise<{ replayed: number; failed: number }> {
  const actions = listPendingActions().reverse();
  clearPendingActions();
  let replayed = 0;
  let failed = 0;
  for (const action of actions) {
    try {
      await action.run();
      replayed += 1;
    } catch (error) {
      failed += 1;
      // A replay that fails for the same reason is worth keeping once more.
      rememberIfReauthNeeded(error, action);
    }
  }
  return { replayed, failed };
}
