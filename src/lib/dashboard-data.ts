import { guardedRpc } from "@/lib/rpc-guard";
import { useMemo } from "react";
import {
  dedupeDepartments,
  dedupeStations,
  useScopedDepartments,
  useScopedStations,
} from "@/lib/scoped-options";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useEffect, useRef } from "react";
import { useScopedRealtime } from "@/lib/realtime-scope";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { reportQueryError } from "@/lib/query-telemetry";
import { sortByAttention } from "@/lib/notification-priority";
import { auditWindowFrom } from "@/lib/audit-window";

/**
 * Explicit reporting periods.
 *
 * A dashboard never shows an unexplained window: the active preset is visible
 * in the period selector, drives every fetched metric/fact, and is printed on
 * each card hint. Calendar presets are for management/financial reading,
 * rolling presets for short operational windows.
 */
export type DashboardPeriodKey =
  | "today"
  | "week"
  | "month"
  | "year"
  | "last7"
  | "last30"
  | "last90";

export const DASHBOARD_PERIODS: {
  key: DashboardPeriodKey;
  label: string;
  kind: "calendar" | "rolling";
}[] = [
  { key: "today", label: "Today", kind: "calendar" },
  { key: "week", label: "This week", kind: "calendar" },
  { key: "month", label: "This month", kind: "calendar" },
  { key: "year", label: "This year", kind: "calendar" },
  { key: "last7", label: "Last 7 days", kind: "rolling" },
  { key: "last30", label: "Last 30 days", kind: "rolling" },
  { key: "last90", label: "Last 90 days", kind: "rolling" },
];

const DAY = 86_400_000;
// Reporting periods are hotel-local calendar dates. Serialising a locally
// constructed midnight with toISOString() moves it into the previous UTC day
// for properties east of Greenwich.
const isoDate = (d: Date) =>
  [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");

export type ResolvedPeriod = {
  key: DashboardPeriodKey;
  label: string;
  kind: "calendar" | "rolling";
  /** Inclusive calendar dates (YYYY-MM-DD). */
  from: string;
  to: string;
  /** Inclusive day count — the legacy `days` contract other RPCs still take. */
  days: number;
};

/** Resolve a preset into an inclusive calendar range. No invented period math. */
export function resolvePeriod(
  key: DashboardPeriodKey = "last30",
  now: Date = new Date(),
): ResolvedPeriod {
  const preset = DASHBOARD_PERIODS.find((p) => p.key === key) ?? DASHBOARD_PERIODS[5]!;
  const end = new Date(now.getTime());
  let start: Date;
  switch (preset.key) {
    case "today":
      start = new Date(end.getTime());
      break;
    case "week": {
      // ISO week — Monday start.
      const dow = (end.getDay() + 6) % 7;
      start = new Date(end.getTime() - dow * DAY);
      break;
    }
    case "month":
      start = new Date(end.getFullYear(), end.getMonth(), 1);
      break;
    case "year":
      start = new Date(end.getFullYear(), 0, 1);
      break;
    case "last7":
      start = new Date(end.getTime() - 6 * DAY);
      break;
    case "last90":
      start = new Date(end.getTime() - 89 * DAY);
      break;
    case "last30":
    default:
      start = new Date(end.getTime() - 29 * DAY);
      break;
  }
  const from = isoDate(start);
  const to = isoDate(end);
  const days =
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
  return { key: preset.key, label: preset.label, kind: preset.kind, from, to, days };
}

/** The period a scope is reporting on, whichever way the scope was built. */
export function scopePeriod(scope: DashboardScope, now: Date = new Date()): ResolvedPeriod {
  return resolvePeriod(scope.period ?? "last30", now);
}

/** Apply a preset to a scope, keeping the legacy `days` contract in step. */
export function withPeriod(scope: DashboardScope, key: DashboardPeriodKey): DashboardScope {
  const period = resolvePeriod(key);
  return { ...scope, period: key, days: period.days };
}

export type DashboardScope = {
  branchId: string | null;
  departmentId: string | null;
  stationId: string | null;
  days: number;
  /** Explicit reporting preset; `days` stays derived from it. */
  period?: DashboardPeriodKey;
};

export const DEFAULT_SCOPE: DashboardScope = {
  branchId: null,
  departmentId: null,
  stationId: null,
  days: 30,
  period: "last30",
};

const rangeFor = (days: number) => {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
};

const scopeArgs = (s: DashboardScope) => {
  const args: { _branch?: string; _department?: string; _station?: string } = {};
  if (s.branchId) args._branch = s.branchId;
  if (s.departmentId) args._department = s.departmentId;
  if (s.stationId) args._station = s.stationId;
  return args;
};

const scopeKey = (s: DashboardScope) => [
  s.branchId,
  s.departmentId,
  s.stationId,
  s.days,
  s.period ?? "last30",
];

/** Aggregated live metrics for the current organisation, scoped by branch/department/station. */
export function useDashboardMetrics(scope: DashboardScope, enabled = true) {
  const period = scopePeriod(scope);
  const from = `${period.from}T00:00:00.000Z`;
  const to = rangeFor(0).to;

  return useQuery({
    queryKey: ["dashboard-metrics", ...scopeKey(scope)],
    enabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "dashboard_metrics", {
        ...scopeArgs(scope),
        _from: from,
        _to: to,
      });
      if (error) throw error;
      return data as Record<string, unknown>;
    },
  });
}

export function useTasksTrend(scope: DashboardScope, enabled = true) {
  return useQuery({
    queryKey: ["tasks-trend", ...scopeKey(scope)],
    enabled,
    queryFn: async () => {
      const { data, error } = await guardedRpc<{ day: string; created: number; completed?: number }[]>(supabase, "tasks_trend", {
        ...scopeArgs(scope),
        _days: Math.min(scope.days, 30),
      });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useDepartmentWorkload(enabled = true) {
  return useQuery({
    queryKey: ["department-workload"],
    enabled,
    queryFn: async () => {
      const { data, error } = await guardedRpc<{ department: string; open_tasks: number; overdue_tasks: number }[]>(supabase, "department_workload");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useStationWorkload(enabled = true) {
  return useQuery({
    queryKey: ["station-workload"],
    enabled,
    queryFn: async () => {
      const { data, error } = await guardedRpc<{ station: string; open_tasks: number; overdue_tasks: number }[]>(supabase, "station_workload");
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Dashboards the signed-in user's roles grant access to, ordered by priority. */
export function useMyDashboards(enabled = true) {
  return useQuery({
    queryKey: ["my-dashboards"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc<{ key: string; name: string }[]>(supabase, "my_dashboards");
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Canonical alert read.
 *
 * Exported as a query descriptor so the boot prefetch warms the *same* cache
 * entry with the *same* projection the panel renders — a prefetch that fetches
 * a narrower row shape under the same key is a duplicate request and a stale
 * render, not a warm cache.
 */
export function dashboardAlertsQuery(branchId: string | null) {
  return {
    queryKey: ["dashboard-alerts", branchId] as const,
    staleTime: 120_000,
    queryFn: async () => {
      let q = supabase
        .from("dashboard_alerts")
        .select("id, title, body, severity, metric, observed_value, created_at")
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(8);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  };
}

export function useDashboardAlerts(scope: DashboardScope, enabled = true) {
  return useQuery({
    ...dashboardAlertsQuery(scope.branchId),
    enabled,
    refetchInterval: 120_000,
  });
}

export function useMyTasks(userId: string | null | undefined, scope: DashboardScope) {
  return useQuery({
    queryKey: ["dashboard-my-tasks", userId, scope.branchId, scope.departmentId, scope.stationId],
    enabled: Boolean(userId),
    queryFn: async () => {
      let q = supabase
        .from("tasks")
        .select("id, reference, title, status, priority, due_at, progress")
        .eq("assignee_id", userId!)
        .not("status", "in", '("completed","cancelled")')
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(8);
      if (scope.branchId) q = q.eq("branch_id", scope.branchId);
      if (scope.departmentId) q = q.eq("department_id", scope.departmentId);
      if (scope.stationId) q = q.eq("station_id", scope.stationId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useTeamTasks(scope: DashboardScope) {
  return useQuery({
    queryKey: ["dashboard-team-tasks", scope.branchId, scope.departmentId, scope.stationId],
    queryFn: async () => {
      let q = supabase
        .from("tasks")
        .select("id, reference, title, status, priority, due_at, progress, assignee_id")
        .not("status", "in", '("completed","cancelled")')
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(10);
      if (scope.branchId) q = q.eq("branch_id", scope.branchId);
      if (scope.departmentId) q = q.eq("department_id", scope.departmentId);
      if (scope.stationId) q = q.eq("station_id", scope.stationId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Canonical pending-approval read (shared with the boot prefetch). */
export function dashboardApprovalsQuery(branchId: string | null, departmentId: string | null) {
  return {
    queryKey: ["dashboard-approvals", branchId, departmentId] as const,
    staleTime: 60_000,
    queryFn: async () => {
      let q = supabase
        .from("approval_requests")
        .select("id, reference, approval_type, reason, amount, level, max_level, created_at")
        .eq("status", "pending_approval")
        .order("created_at", { ascending: true })
        .limit(8);
      if (branchId) q = q.eq("branch_id", branchId);
      if (departmentId) q = q.eq("department_id", departmentId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  };
}

export function usePendingApprovals(scope: DashboardScope) {
  return useQuery({
    ...dashboardApprovalsQuery(scope.branchId, scope.departmentId),
    refetchInterval: 60_000,
  });
}

/** Canonical notification read (shared with the boot prefetch). */
export function dashboardNotificationsQuery(branchId: string | null) {
  return {
    queryKey: ["dashboard-notifications", branchId] as const,
    staleTime: 60_000,
    queryFn: async () => {
      // Property-owned notices follow the selected property; organisation-wide
      // notices (no property) stay visible in every property view.
      let q = supabase
        .from("notifications")
        .select(
          "id, title, body, category, priority, read_at, created_at, action_required, status, event_type",
        )
        .order("created_at", { ascending: false })
        .limit(30);
      if (branchId) q = q.or(`branch_id.eq.${branchId},branch_id.is.null`);
      const { data, error } = await q;
      if (error) {
        reportQueryError("notifications.dashboard", error);
        throw error;
      }
      // Attention order, then recency — the panel shows the eight that matter,
      // not simply the eight most recent.
      return sortByAttention(data ?? []).slice(0, 8);
    },
  };
}

export function useDashboardNotifications(scope: DashboardScope) {
  return useQuery({
    ...dashboardNotificationsQuery(scope.branchId),
    // Notices are not a live feed; a two minute poll halves a read that is
    // heavy because every row is scope-checked by row level security.
    refetchInterval: 120_000,
  });
}

export function useRecentActivity(scope: DashboardScope, enabled = true) {
  return useQuery({
    queryKey: ["dashboard-activity", scope.branchId],
    enabled,
    refetchInterval: 120_000,
    queryFn: async () => {
      let q = supabase
        .from("audit_logs")
        .select("id, action, module, user_name, created_at")
        .gte("created_at", auditWindowFrom(30))
        .order("created_at", { ascending: false })
        .limit(10);
      if (scope.branchId) q = q.or(`branch_id.eq.${scope.branchId},branch_id.is.null`);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useKpiDefinitions(enabled = true) {
  return useQuery({
    queryKey: ["kpi-definitions"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("kpi_definitions")
        .select("key, name, definition, unit, availability, active")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useScopeOptions(organizationId: string | null) {
  // Property first, then department, then station — the same chain the backend
  // enforces. Branch-scoped operators never see another property's options.
  const { branchId } = useActivePropertyFilter();
  const departments = useScopedDepartments();
  const stations = useScopedStations();
  const branches = useQuery({
    queryKey: ["dashboard-scope-branches", organizationId, branchId],
    enabled: Boolean(organizationId),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("branches")
        .select("id, name")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const data = useMemo(
    () => ({
      branches: (branches.data ?? []).filter((b) => !branchId || b.id === branchId),
      departments: dedupeDepartments(departments.data ?? [], branchId),
      stations: dedupeStations(stations.data ?? [], branchId, null),
    }),
    [branches.data, departments.data, stations.data, branchId],
  );

  return {
    data,
    isLoading: branches.isLoading || departments.isLoading || stations.isLoading,
    error: branches.error ?? departments.error ?? stations.error,
  };
}

/* ------------------------------ live updates ----------------------------- */

/**
 * Dashboard counts follow the record state, not the page load.
 *
 * Every table that feeds a dashboard figure is published to the live feed, so
 * a room condition change, a new cleaning job, a closed work order, a task or
 * an approval immediately marks the affected dashboard queries stale and the
 * visible counts re-resolve from the authoritative reads. Invalidation is
 * coalesced so a burst of changes costs one refresh, and a slow periodic sweep
 * keeps figures honest if the socket ever drops.
 */
const DASHBOARD_LIVE_TABLES = [
  "tasks",
  "notifications",
  "rooms",
  "housekeeping_jobs",
  "maintenance_work_orders",
  "reservations",
] as const;

const DASHBOARD_LIVE_KEYS = [
  "dashboard-metrics",
  "tasks-trend",
  "department-workload",
  "station-workload",
  "dashboard-alerts",
  "dashboard-my-tasks",
  "dashboard-team-tasks",
  "dashboard-approvals",
  "dashboard-notifications",
  "dashboard-activity",
];

export function useDashboardRealtime(enabled = true) {
  const qc = useQueryClient();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = () => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      for (const key of DASHBOARD_LIVE_KEYS) void qc.invalidateQueries({ queryKey: [key] });
    }, 400);
  };

  useScopedRealtime(
    "dashboard-live",
    DASHBOARD_LIVE_TABLES.map((table) => ({ table, onChange: refresh })),
    enabled,
  );

  useEffect(() => {
    if (!enabled) return;
    const sweep = setInterval(refresh, 120000);
    return () => {
      if (pending.current) clearTimeout(pending.current);
      clearInterval(sweep);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, enabled]);
}
