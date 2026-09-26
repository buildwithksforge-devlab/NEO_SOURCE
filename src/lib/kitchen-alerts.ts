/**
 * Kitchen alerts, routing health and reconciliation status.
 *
 * All three read the authoritative server routines — no client-side derivation:
 *  - `public.neo_kitchen_routing_health` — missing-routing rate, invariant
 *    violations and partition counts.
 *  - `public.neo_kitchen_reconciliation_status` — last successful run, run
 *    history with idempotency flags, and suppressed duplicate alerts.
 *  - `public.neo_kitchen_raise_alerts` — deduplicated notification emission.
 */

import { guardedRpc } from "@/lib/rpc-guard";
import { useScopedRealtime } from "@/lib/realtime-scope";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export type RoutingHealth = {
  configured: boolean;
  window_days: number;
  items_total: number;
  items_missing_routing: number;
  missing_routing_rate: number;
  violations: { violation: string; count: number }[];
  mixed_station_tickets: number;
  unrouted_tickets: number;
  partitioned_tickets: number;
  partitioned_orders: number;
};

export type ReconciliationRun = {
  id: string;
  ran_at: string;
  tickets_assigned: number;
  partitions_created: number;
  items_moved: number;
  items_without_routing: number;
  idempotent: boolean;
  duration_ms: number;
  status: string;
  error: string | null;
};

export type ReconciliationStatus = {
  configured: boolean;
  last_successful_run: ReconciliationRun | null;
  runs: ReconciliationRun[];
  alerts_by_kind: { kind: string; delivered: number; suppressed: number }[];
  alerts_delivered_7d: number;
  alerts_suppressed_7d: number;
};

export type KitchenAlert = {
  id: string;
  title: string;
  body: string;
  link: string | null;
  priority: string;
  event_type: string | null;
  read_at: string | null;
  created_at: string;
};

export const KITCHEN_ALERT_KINDS = [
  "station-workload",
  "missing-routing",
  "invariant-violation",
  "bulk-action-rejected",
] as const;

export type KitchenAlertKind = (typeof KITCHEN_ALERT_KINDS)[number];

export const KITCHEN_ALERT_LABELS: Record<string, string> = {
  "station-workload": "Station workload",
  "missing-routing": "Missing routing",
  "invariant-violation": "Routing invariant",
  "bulk-action-rejected": "Bulk action rejected",
};

/** Realtime kitchen alert feed for chefs and managers. */
export function useKitchenAlerts(limit = 25) {
  const { organizationId } = useAuth();
  const qc = useQueryClient();

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["kitchen", "alerts"] });
    void qc.invalidateQueries({ queryKey: ["kitchen", "reconciliation-status"] });
  };
  useScopedRealtime("kitchen-alerts-live", [
    { table: "notifications", onChange: invalidate },
    { table: "kitchen_alert_log", onChange: invalidate },
  ]);


  return useQuery({
    queryKey: ["kitchen", "alerts", organizationId, limit],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<KitchenAlert[]> => {
      const { data, error } = await supabase
        .from("notifications")
        .select("id, title, body, link, priority, event_type, read_at, created_at")
        .eq("source_module", "kitchen")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as unknown as KitchenAlert[];
    },
  });
}

export function useKitchenAlertMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 0) return;
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["kitchen", "alerts"] }),
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useKitchenRoutingHealth() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["kitchen", "routing-health", organizationId, branchId ?? "all"],
    enabled: Boolean(organizationId),
    refetchInterval: 60_000,
    queryFn: async (): Promise<RoutingHealth> => {
      const { data, error } = await guardedRpc(supabase, 
        "neo_kitchen_routing_health" as never,
        (branchId ? { _branch: branchId } : {}) as never,
      );
      if (error) throw error;
      const h = (data ?? {}) as Partial<RoutingHealth>;
      return {
        configured: h.configured ?? false,
        window_days: h.window_days ?? 30,
        items_total: h.items_total ?? 0,
        items_missing_routing: h.items_missing_routing ?? 0,
        missing_routing_rate: Number(h.missing_routing_rate ?? 0),
        violations: h.violations ?? [],
        mixed_station_tickets: h.mixed_station_tickets ?? 0,
        unrouted_tickets: h.unrouted_tickets ?? 0,
        partitioned_tickets: h.partitioned_tickets ?? 0,
        partitioned_orders: h.partitioned_orders ?? 0,
      };
    },
  });
}

export function useKitchenReconciliationStatus() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["kitchen", "reconciliation-status", organizationId, branchId ?? "all"],
    enabled: Boolean(organizationId),
    refetchInterval: 60_000,
    queryFn: async (): Promise<ReconciliationStatus> => {
      const { data, error } = await guardedRpc(supabase, 
        "neo_kitchen_reconciliation_status" as never,
        (branchId ? { _branch: branchId } : {}) as never,
      );
      if (error) throw error;
      const s = (data ?? {}) as Partial<ReconciliationStatus>;
      return {
        configured: s.configured ?? false,
        last_successful_run: s.last_successful_run ?? null,
        runs: s.runs ?? [],
        alerts_by_kind: s.alerts_by_kind ?? [],
        alerts_delivered_7d: s.alerts_delivered_7d ?? 0,
        alerts_suppressed_7d: s.alerts_suppressed_7d ?? 0,
      };
    },
  });
}

/** Logged reconciliation run — records idempotency and partition counts. */
export function useKitchenReconcileRun() {
  const qc = useQueryClient();
  const { branchId } = useActivePropertyFilter();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(supabase, 
        "neo_kitchen_reconcile_stations_run" as never,
        (branchId ? { _branch: branchId } : {}) as never,
      );
      if (error) throw error;
      return (data ?? {}) as {
        tickets_assigned?: number;
        partitions_created?: number;
        items_moved?: number;
        items_without_routing?: number;
      };
    },
    onSuccess: (res) => {
      toast.success(
        `Reconciled ${res.tickets_assigned ?? 0} ticket(s), ${res.partitions_created ?? 0} partition(s); ` +
          `${res.items_without_routing ?? 0} item(s) still unrouted.`,
      );
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Evaluates workload and routing thresholds, raising deduplicated alerts. */
export function useKitchenRaiseAlerts() {
  const qc = useQueryClient();
  const { branchId } = useActivePropertyFilter();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(supabase, 
        "neo_kitchen_raise_alerts" as never,
        (branchId ? { _branch: branchId } : {}) as never,
      );
      if (error) throw error;
      return (data ?? {}) as { raised?: number; suppressed?: number };
    },
    onSuccess: (res) => {
      toast.success(`${res.raised ?? 0} alert(s) raised, ${res.suppressed ?? 0} duplicate(s) suppressed.`);
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
