/**
 * Bar department layer.
 *
 * The Bar is a standalone department: the Bar Manager supervises the whole
 * department, while each Bar Attendant owns only the orders they accepted.
 * Every write goes through a database routine that re-checks the caller's
 * `bar.*` capability and, for attendants, that the ticket is theirs — so
 * ownership isolation cannot be bypassed from the browser.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type BarRow = Record<string, unknown>;

export type BarQueueView = "live" | "all" | "delayed" | "new" | "accepted" | "preparing" | "ready";
export type BarQueueScope = "all" | "mine" | "unassigned";

export function useBarContext() {
  const { organizationId, profile } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback };
}

export function useBarMetrics() {
  const { organizationId, branchId } = useBarContext();
  return useQuery({
    queryKey: ["bar", "metrics", organizationId, branchId],
    enabled: Boolean(organizationId),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_bar_metrics", { _branch: branchId ?? null });
      if (error) throw new Error(error.message);
      return (data ?? {}) as BarRow;
    },
  });
}

export function useBarQueue(view: BarQueueView = "live", scope: BarQueueScope = "all") {
  const { organizationId, branchId } = useBarContext();
  return useQuery({
    queryKey: ["bar", "queue", organizationId, branchId, view, scope],
    enabled: Boolean(organizationId),
    refetchInterval: 20_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_bar_queue", {
        _branch: branchId ?? null,
        _view: view,
        _scope: scope,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as BarRow[];
    },
  });
}

function useBarInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["bar"] });
    void qc.invalidateQueries({ queryKey: ["kitchen"] });
    void qc.invalidateQueries({ queryKey: ["pos"] });
  };
}

export function useAcceptBarTicket() {
  const invalidate = useBarInvalidate();
  return useMutation({
    mutationFn: async (ticketId: string) => {
      const { data, error } = await guardedRpc(db, "neo_bar_accept_ticket", { _ticket: ticketId });
      if (error) throw new Error(error.message);
      return (data ?? {}) as BarRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Order accepted — it is now yours to prepare");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAdvanceBarTicket() {
  const invalidate = useBarInvalidate();
  return useMutation({
    mutationFn: async (input: { ticketId: string; to: string; reason?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_bar_advance_ticket", {
        _ticket: input.ticketId,
        _to: input.to,
        _reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as BarRow;
    },
    onSuccess: (_d, vars) => {
      invalidate();
      toast.success(`Order moved to ${vars.to}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReassignBarTicket() {
  const invalidate = useBarInvalidate();
  return useMutation({
    mutationFn: async (input: { ticketId: string; toUser: string; reason: string }) => {
      const { data, error } = await guardedRpc(db, "neo_bar_reassign_ticket", {
        _ticket: input.ticketId,
        _to_user: input.toUser,
        _reason: input.reason,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as BarRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Order reassigned — the audit trail keeps the original assignment");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Bar attendants in the caller's organisation, for reassignment. */
export function useBarAttendants() {
  const { organizationId, branchId } = useBarContext();
  return useQuery({
    queryKey: ["bar", "attendants", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      // `user_roles` has no foreign key to `profiles`, so PostgREST cannot embed
      // them in one request. Read the role rows first, then the matching profiles.
      const { data: roleRows, error: roleError } = await db
        .from("user_roles")
        .select("user_id, roles!inner(name)")
        .limit(500);
      if (roleError) throw new Error(roleError.message);
      const barUserIds = ((roleRows ?? []) as BarRow[])
        .filter((r) => String((r["roles"] as { name?: string } | null)?.name ?? "").toLowerCase().includes("bar"))
        .map((r) => String(r["user_id"]))
        .filter(Boolean);
      if (barUserIds.length === 0) return [] as { id: string; name: string; branchId: string | null }[];
      const { data: profileRows, error: profileError } = await db
        .from("profiles")
        .select("id, full_name, branch_id")
        .in("id", Array.from(new Set(barUserIds)));
      if (profileError) throw new Error(profileError.message);
      return ((profileRows ?? []) as BarRow[])
        .map((p) => ({
          id: String(p["id"]),
          name: (p["full_name"] as string | null) ?? "Unnamed",
          branchId: (p["branch_id"] as string | null) ?? null,
        }))
        .filter((p) => (branchId ? !p.branchId || p.branchId === branchId : true));
    },

  });
}

/**
 * The bar-scoped slice of the canonical menu catalogue.
 *
 * There is no second bar menu: `neo_bar_menu` reads the same `menu_items`
 * records the restaurant sells from, and returns only those whose resolved
 * production station is a bar station of the selected property. Editing an item
 * here edits that same canonical record.
 */
export type BarMenuItem = {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  currency: string | null;
  image_url: string | null;
  prep_minutes: number | null;
  recipe_status: string;
  category_id: string | null;
  category_name: string | null;
  menu_id: string | null;
  menu_name: string | null;
  base_price: number;
  tax_rate: number | null;
  availability: string;
  publish_status: string;
  branch_id: string | null;
  branch_name: string | null;
  department_id: string | null;
  department_name: string | null;
  station_id: string | null;
  station_name: string | null;
  station_source: string | null;
  assigned_station_id: string | null;
  updated_at: string;
};

export function useBarMenu(includeDrafts = false) {
  const { organizationId, branchId } = useBarContext();
  return useQuery({
    queryKey: ["bar", "menu", organizationId, branchId, includeDrafts],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_bar_menu", {
        _branch: branchId ?? null,
        _include_drafts: includeDrafts,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as BarMenuItem[];
    },
  });
}

/** Bar tabs still open — the same `pos_orders` records the POS terminal settles. */
export type BarOpenOrder = {
  order_id: string;
  order_number: string;
  order_type: string;
  order_source: string | null;
  status: string;
  payment_status: string | null;
  table_code: string | null;
  guest_name: string | null;
  waiter_name: string | null;
  item_count: number;
  grand_total: number;
  paid_total: number;
  currency: string | null;
  created_at: string;
};

export function useBarOpenOrders() {
  const { organizationId, branchId } = useBarContext();
  return useQuery({
    queryKey: ["bar", "open-orders", organizationId, branchId],
    enabled: Boolean(organizationId),
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_bar_open_orders", { _branch: branchId ?? null });
      if (error) throw new Error(error.message);
      return (data ?? []) as BarOpenOrder[];
    },
  });
}

/** The next status a bar ticket may move to. */
export function nextBarStatus(status: string): string | null {
  switch (status) {
    case "accepted":
      return "preparing";
    case "preparing":
      return "ready";
    case "ready":
      return "served";
    case "served":
      return "completed";
    default:
      return null;
  }
}

export const barStr = (v: unknown, fallback = "—") =>
  v === null || v === undefined || v === "" ? fallback : String(v);

export const barNum = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

/**
 * Everything the Bar Dashboard shows, read in one scoped call.
 *
 * `neo_bar_overview` re-checks `bar.overview.view` and resolves the bar's own
 * stations, departments and storage locations server-side, so the figures can
 * never widen past the selected property or leak another department's stock,
 * approvals or wastage.
 */
export type BarOverview = {
  open_tabs: { count: number; value: number; rows: BarRow[] };
  queue: { count: number; delayed: number; rows: BarRow[] };
  approvals: { count: number; value: number; rows: BarRow[] };
  low_stock: { count: number; rows: BarRow[] };
  wastage: { count: number; value_today: number; rows: BarRow[] };
};

const EMPTY_SECTION = { count: 0, value: 0, delayed: 0, value_today: 0, rows: [] as BarRow[] };

export function useBarOverview() {
  const { organizationId, branchId } = useBarContext();
  return useQuery({
    queryKey: ["bar", "overview", organizationId, branchId],
    enabled: Boolean(organizationId),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_bar_overview", { _branch: branchId ?? null });
      if (error) throw new Error(error.message);
      const raw = (data ?? {}) as Record<string, unknown>;
      const section = (key: string) => ({ ...EMPTY_SECTION, ...((raw[key] ?? {}) as object) });
      return {
        open_tabs: section("open_tabs"),
        queue: section("queue"),
        approvals: section("approvals"),
        low_stock: section("low_stock"),
        wastage: section("wastage"),
      } as unknown as BarOverview;
    },
  });
}

/**
 * The bar's own stations and departments, used to narrow shared F&B lists
 * (stores requisitions, wastage) down to the Bar department only. Both reads
 * are RLS-scoped, so a user only ever sees the structure they may see.
 */
export function useBarScopeIds() {
  const { organizationId, branchId } = useBarContext();
  return useQuery({
    queryKey: ["bar", "scope-ids", organizationId, branchId],
    enabled: Boolean(organizationId),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      let stationQuery = db
        .from("operational_stations")
        .select("id, department_id, code, name, station_type")
        .limit(200);
      let deptQuery = db.from("departments").select("id, code, name").limit(300);
      if (branchId) {
        stationQuery = stationQuery.eq("branch_id", branchId);
        deptQuery = deptQuery.eq("branch_id", branchId);
      }
      const [stations, departments] = await Promise.all([stationQuery, deptQuery]);
      if (stations.error) throw new Error(stations.error.message);
      if (departments.error) throw new Error(departments.error.message);

      const isBarLabel = (value: unknown) => {
        const text = String(value ?? "").toLowerCase();
        if (!text) return false;
        if (text.includes("barista") || text.includes("coffee")) return false;
        return text.includes("bar") || text.includes("beverage");
      };

      const barStations = ((stations.data ?? []) as BarRow[]).filter(
        (s) =>
          String(s["station_type"] ?? "") === "beverage" ||
          isBarLabel(s["code"]) ||
          isBarLabel(s["name"]),
      );
      const barDepartments = ((departments.data ?? []) as BarRow[]).filter(
        (d) => isBarLabel(d["code"]) || isBarLabel(d["name"]),
      );
      const departmentIds = new Set<string>(barDepartments.map((d) => String(d["id"])));
      for (const s of barStations) {
        if (s["department_id"]) departmentIds.add(String(s["department_id"]));
      }
      return {
        stationIds: barStations.map((s) => String(s["id"])),
        departmentIds: [...departmentIds],
      };
    },
  });
}

/** Keep only the rows belonging to the Bar department (or its stations). */
export function filterToBarScope<T extends BarRow>(
  rows: T[],
  scope: { stationIds: string[]; departmentIds: string[] } | undefined,
  key: "department_id" | "station_id",
): T[] {
  if (!scope) return rows;
  const allowed = key === "station_id" ? scope.stationIds : scope.departmentIds;
  if (allowed.length === 0) return rows;
  const set = new Set(allowed);
  return rows.filter((r) => {
    const value = r[key];
    return value === null || value === undefined || set.has(String(value));
  });
}
