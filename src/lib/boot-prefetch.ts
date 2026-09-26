/**
 * Boot-gate idle prefetch.
 *
 * Once the effective-access contract is confirmed, the workspace shell is
 * mounted but the browser is otherwise idle while the user reads the first
 * screen. That idle window is used to warm the query cache for the data every
 * workspace needs, so entering a module no longer triggers a fresh fetch
 * cascade.
 *
 * Rules this layer obeys:
 *  - it prefetches only what the signed-in user is already permitted to read
 *    (every query goes through the same RLS-protected client as the screens);
 *  - it never invents, seeds or caches placeholder data — a failed prefetch is
 *    silently dropped and the screen fetches normally;
 *  - it reuses the exact query keys the module hooks use, so a warmed entry is
 *    the same cache entry the screen reads.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  dashboardAlertsQuery,
  dashboardApprovalsQuery,
  dashboardNotificationsQuery,
} from "@/lib/dashboard-data";

export type BootPrefetchScope = {
  organizationId: string | null;
  branchId: string | null;
};

type Job = {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  staleTime: number;
};

/** The query entries every workspace opens with, whatever the dashboard. */
export function bootPrefetchJobs(scope: BootPrefetchScope): Job[] {
  const { organizationId, branchId } = scope;
  const jobs: Job[] = [
    {
      queryKey: ["my-dashboards"],
      staleTime: 5 * 60_000,
      queryFn: async () => {
        const { data, error } = await guardedRpc(supabase, "my_dashboards");
        if (error) throw error;
        return data ?? [];
      },
    },
    // These reuse the exact query descriptors the dashboard panels use, so a
    // warmed entry is the same cache entry with the same row shape. A near-copy
    // here caused a second network round trip on every boot and a first render
    // missing fields the panel needs.
    //
    // Notifications are deliberately NOT prefetched: the shell's own inbox read
    // already loads the same rows on every route, so warming the panel copy
    // added a second notifications request to every page the panel never
    // appears on.
    { ...dashboardApprovalsQuery(branchId, null) },
    { ...dashboardAlertsQuery(branchId) },
    {
      queryKey: ["department-workload"],
      staleTime: 120_000,
      queryFn: async () => {
        const { data, error } = await guardedRpc(supabase, "department_workload");
        if (error) throw error;
        return data ?? [];
      },
    },
  ];

  if (organizationId) {
    jobs.push({
      queryKey: ["branches", organizationId],
      staleTime: 60_000,
      queryFn: async () => {
        const { data, error } = await supabase
          .from("branches")
          .select("*")
          .order("is_main", { ascending: false })
          .order("name", { ascending: true });
        if (error) throw error;
        return (data ?? []) as unknown as Record<string, unknown>[];
      },
    });
  }

  return jobs;
}

function whenIdle(run: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const handle = w.requestIdleCallback(run, { timeout: 2000 });
    return () => w.cancelIdleCallback?.(handle);
  }
  const timer = window.setTimeout(run, 600);
  return () => window.clearTimeout(timer);
}

/**
 * Warms the shared workspace queries during idle time.
 * Returns a cancel function; prefetch failures are intentionally ignored.
 */
export function prefetchWorkspaceData(
  queryClient: QueryClient,
  scope: BootPrefetchScope,
): () => void {
  return whenIdle(() => {
    for (const job of bootPrefetchJobs(scope)) {
      void queryClient.prefetchQuery(job).catch(() => {});
    }
    // Start-up health check: confirm the critical routines are still executable
    // by the role the callable-surface manifest declares.
    void import("@/lib/rpc-health")
      .then((m) => m.runRpcPrivilegeCheck())
      .catch(() => {});
  });
}

