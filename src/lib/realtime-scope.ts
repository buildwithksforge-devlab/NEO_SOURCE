import { useEffect, useRef, useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { recordActionSpan, RELEASE, newCorrelationId } from "@/lib/perf-telemetry";

/**
 * Tenant-scoped realtime.
 *
 * Every live table listed here carries `organization_id`, so each subscription is
 * filtered to the signed-in workspace. Without the filter every client is woken by
 * every other tenant's activity — no data leaks (reads stay access-checked) but the
 * timing and volume of another workspace's work is observable.
 *
 * Three things beyond the filter matter operationally:
 *
 *  - A dropped socket must not look like a quiet shift. The connection state is
 *    published so screens can show "Reconnecting" instead of stale figures
 *    presented as current.
 *  - Reconnecting is not enough by itself: changes committed while the socket
 *    was down were never delivered, so every reconnect is followed by an
 *    authoritative resync of the bound screens.
 *  - Delivery is measured. Each change carries the commit timestamp, so the
 *    lag between the database commit and this screen updating is recorded like
 *    any other action, and can be reported at p95/p99.
 */
export type RealtimeBinding = {
  table: string;
  onChange: () => void;
};

/* ------------------------------------------------------- connection status */

export type RealtimeConnection = "connecting" | "live" | "reconnecting" | "off";

type StatusState = {
  connection: RealtimeConnection;
  /** When a change last arrived, or a resync last succeeded. */
  lastUpdateAt: number | null;
  /** Consecutive failed attempts; drives the backoff and the warning. */
  attempts: number;
};

let status: StatusState = { connection: "off", lastUpdateAt: null, attempts: 0 };
const statusListeners = new Set<() => void>();
const channels = new Set<string>();

function setStatus(next: Partial<StatusState>) {
  status = { ...status, ...next };
  for (const listener of statusListeners) listener();
}

function subscribeStatus(listener: () => void) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function snapshot(): StatusState {
  return status;
}

/**
 * Live-update state for the header indicator. `off` means no screen on this tab
 * subscribes to anything, which is normal for a static page.
 */
export function useRealtimeStatus(): StatusState {
  return useSyncExternalStore(subscribeStatus, snapshot, snapshot);
}

/** Test-only. */
export function resetRealtimeStatus() {
  status = { connection: "off", lastUpdateAt: null, attempts: 0 };
  channels.clear();
  statusListeners.clear();
}

/** Backoff for reconnection: quick at first, then patient, capped at 30s. */
export function backoffDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

/* ------------------------------------------------------------ subscription */

type ChangePayload = {
  commit_timestamp?: string;
  table?: string;
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
};

/** Record how long a committed change took to reach this screen. */
function recordPropagation(table: string, payload: ChangePayload, propertyId: string | null) {
  const committed = payload.commit_timestamp ? Date.parse(payload.commit_timestamp) : NaN;
  if (!Number.isFinite(committed)) return;
  const lag = Date.now() - committed;
  // A clock skewed backwards would otherwise report a negative or absurd lag.
  if (lag < 0 || lag > 120_000) return;
  recordActionSpan({
    action: `realtime.${table}`,
    kind: "propagation",
    correlationId: newCorrelationId(),
    propertyId,
    release: RELEASE,
    durationMs: lag,
    outcome: "ok",
    retries: 0,
    at: committed,
  });
}

export function useScopedRealtime(
  channelName: string,
  bindings: RealtimeBinding[],
  enabled = true,
  options: { propertyId?: string | null; onResync?: () => void } = {},
) {
  const { organizationId } = useAuth();
  // Bindings are recreated per render; the table list is the stable identity.
  const signature = bindings.map((b) => b.table).join("|");

  // Kept in a ref so a re-render never tears down a healthy socket just because
  // the handler identity changed.
  const latest = useRef({ bindings, options });
  latest.current = { bindings, options };

  useEffect(() => {
    if (!enabled || !organizationId) return;

    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const key = `${channelName}:${organizationId}`;
    channels.add(key);

    /** Everything the socket may have missed while it was down. */
    const resync = () => {
      for (const binding of latest.current.bindings) binding.onChange();
      latest.current.options.onResync?.();
      setStatus({ lastUpdateAt: Date.now() });
    };

    const open = (isRetry: boolean) => {
      if (disposed) return;
      setStatus({ connection: isRetry ? "reconnecting" : "connecting", attempts: attempt });

      let next = supabase.channel(key);
      for (const binding of latest.current.bindings) {
        next = next.on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: binding.table,
            filter: `organization_id=eq.${organizationId}`,
          },
          (payload: ChangePayload) => {
            recordPropagation(binding.table, payload, latest.current.options.propertyId ?? null);
            setStatus({ lastUpdateAt: Date.now() });
            binding.onChange();
          },
        );
      }

      next.subscribe((state: string) => {
        if (disposed) return;
        if (state === "SUBSCRIBED") {
          const wasDown = attempt > 0;
          attempt = 0;
          setStatus({ connection: "live", attempts: 0, lastUpdateAt: Date.now() });
          // Only resync after an actual outage: the first connect is followed
          // by the screen's own initial read.
          if (wasDown) resync();
          return;
        }
        if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
          setStatus({ connection: "reconnecting", attempts: attempt + 1 });
          if (retry) clearTimeout(retry);
          attempt += 1;
          const wait = backoffDelayMs(attempt);
          retry = setTimeout(() => {
            if (disposed) return;
            if (channel) void supabase.removeChannel(channel);
            open(true);
          }, wait);
        }
      });

      channel = next;
    };

    open(false);

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (channel) void supabase.removeChannel(channel);
      channels.delete(key);
      if (channels.size === 0) setStatus({ connection: "off" });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelName, organizationId, enabled, signature]);
}
