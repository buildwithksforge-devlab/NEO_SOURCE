/**
 * Canonical kitchen ticket contract.
 *
 * ONE source, ONE lifecycle. Both the POS Kitchen Display (`/pos/kds`) and the
 * Kitchen Live Queue (`/kitchen/queue`) read `public.neo_kitchen_queue` and
 * mutate through `public.neo_kitchen_ticket_transition` /
 * `public.neo_kitchen_ticket_delay`. No screen may query `station_tickets`
 * directly again — divergent selects and filters were the reason the two pages
 * disagreed in production.
 *
 * Delay is metadata (reason + event), never a lifecycle state.
 */

import { guardedRpc } from "@/lib/rpc-guard";
import { useScopedRealtime } from "@/lib/realtime-scope";
import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type KitchenTicketItem = {
  ticket_item_id: string;
  order_item_id: string | null;
  status: string;
  chef_id: string | null;
  production_note: string | null;
  item_name: string | null;
  quantity: number | null;
  course: string | null;
  special_instructions: string | null;
  allergy_note: string | null;
  modifiers: { group_name: string | null; option_name: string | null }[];
};

export type KitchenTicket = {
  ticket_id: string;
  ticket_number: string;
  status: string;
  priority: string;
  priority_reason: string | null;
  delay_reason: string | null;
  branch_id: string | null;
  department_id: string | null;
  station_id: string | null;
  station_name: string | null;
  station_missing: boolean;
  order_id: string | null;
  order_number: string | null;
  order_type: string | null;
  table_code: string | null;
  guest_name: string | null;
  guest_count: number | null;
  waiter_id: string | null;
  allergy_alert: string | null;
  dietary_notes: string | null;
  course: string | null;
  target_minutes: number;
  received_at: string | null;
  accepted_at: string | null;
  started_at: string | null;
  ready_at: string | null;
  age_minutes: number;
  is_delayed: boolean;
  items: KitchenTicketItem[];
};

/* ------------------------------------------------------------------ *
 * Lifecycle contract — mirrors neo_kitchen_ticket_transition()
 * ------------------------------------------------------------------ */

export const TICKET_LIFECYCLE = [
  "new",
  "accepted",
  "preparing",
  "partially-ready",
  "ready",
  "served",
  "completed",
] as const;

export const TERMINAL_TICKET_STATUSES = ["completed", "cancelled"] as const;

/** The server is authoritative; this map only decides which buttons render. */
export const TICKET_TRANSITIONS: Record<string, string[]> = {
  new: ["accepted", "cancelled"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  "partially-ready": ["ready", "cancelled"],
  ready: ["served"],
  served: ["completed"],
};

export const TICKET_ACTION_LABELS: Record<string, string> = {
  accepted: "Accept",
  preparing: "Start preparing",
  ready: "Mark ready",
  served: "Served",
  completed: "Complete",
  cancelled: "Cancel ticket",
};

/** Actions are derived from the transition contract, never hardcoded per page. */
export function ticketActions(
  status: string,
): { to: string; label: string; needsReason: boolean }[] {
  return (TICKET_TRANSITIONS[status] ?? []).map((to) => ({
    to,
    label: TICKET_ACTION_LABELS[to] ?? to,
    needsReason: to === "cancelled",
  }));
}

/* ---- Item level: same state-machine family, one server contract ---- */

/** Mirrors `neo_kitchen_item_transition()`. The server re-validates every move. */
export const ITEM_TRANSITIONS: Record<string, string[]> = {
  new: ["accepted", "cancel-pending"],
  accepted: ["preparing", "cancel-pending"],
  preparing: ["ready", "cancel-pending"],
  ready: ["collected", "served", "remake-requested"],
  collected: ["served", "remake-requested"],
  served: ["completed", "remake-requested"],
  "cancel-pending": ["cancelled", "accepted", "preparing"],
  "remake-requested": ["remaking"],
  remaking: ["ready"],
};

export const ITEM_ACTION_LABELS: Record<string, string> = {
  accepted: "Accept",
  preparing: "Start preparing",
  ready: "Mark ready",
  collected: "Collected",
  served: "Served",
  completed: "Complete",
  "cancel-pending": "Request cancellation",
  cancelled: "Cancel",
  "remake-requested": "Request remake",
  remaking: "Start remake",
};

export const TERMINAL_ITEM_STATUSES = ["completed", "cancelled"] as const;

export function itemActions(status: string): { to: string; label: string; needsReason: boolean }[] {
  return (ITEM_TRANSITIONS[status] ?? []).map((to) => ({
    to,
    label: ITEM_ACTION_LABELS[to] ?? to,
    needsReason: to.includes("cancel") || to.includes("remake"),
  }));
}

/** Aggregate the ticket header exactly as `neo_kitchen_aggregate_ticket()` does. */
export function deriveTicketStatus(itemStatuses: string[]): string {
  const active = itemStatuses.filter((s) => s !== "cancelled");
  if (active.length === 0) return "cancelled";
  const count = (list: string[]) => active.filter((s) => list.includes(s)).length;
  const readyPlus = count(["ready", "collected", "served", "completed"]);
  if (count(["completed"]) === active.length) return "completed";
  if (count(["served", "completed"]) === active.length) return "served";
  if (readyPlus === active.length) return "ready";
  if (readyPlus > 0) return "partially-ready";
  if (count(["preparing", "remaking", "remake-requested"]) > 0) return "preparing";
  if (count(["accepted", "cancel-pending"]) > 0) return "accepted";
  return "new";
}

export function isTerminalTicket(status: string) {
  return (TERMINAL_TICKET_STATUSES as readonly string[]).includes(status);
}

export function isTerminalItem(status: string) {
  return (TERMINAL_ITEM_STATUSES as readonly string[]).includes(status);
}

/** Normalises historic/legacy status spellings onto the canonical contract. */
export function canonicalTicketStatus(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s === "in_progress" || s === "in-progress" || s === "in-preparation") return "preparing";
  if (s === "queued") return "new";
  if (s === "delayed") return "preparing"; // delay is metadata, not a lifecycle state
  if (s === "partially_ready") return "partially-ready";
  return s || "new";
}

/* ------------------------------------------------------------------ *
 * Production-station routing contract — mirrors neo_kitchen_resolve_station
 * ------------------------------------------------------------------ */

/**
 * Deterministic precedence used by POS send-to-kitchen, ticket backfill and
 * the reconciliation RPC. An unresolved item is a typed configuration
 * exception; the server never picks an arbitrary station.
 */
export const STATION_ROUTING_PRECEDENCE = [
  "rule-item",
  "rule-category",
  "order-item",
  "menu-item",
  "menu-category",
  "missing-routing",
] as const;

export type StationRoutingSource = (typeof STATION_ROUTING_PRECEDENCE)[number];

/** A ticket only carries a routing exception when the canonical station is absent. */
export function ticketRoutingException(
  ticket: Pick<KitchenTicket, "station_id" | "station_missing">,
) {
  return ticket.station_id == null || ticket.station_missing;
}

export const ROUTING_EXCEPTION_MESSAGE =
  "No production station could be resolved for these items. Add a routing rule, or set a station on the menu item or its category, so the ticket reaches the right team.";

export const KITCHEN_TICKETS_QUERY_KEY = ["kitchen", "tickets"] as const;

/* ------------------------------------------------------------------ *
 * Read — one query, one key, shared by both live pages
 * ------------------------------------------------------------------ */

export type QueueView = "live" | "all" | "delayed" | "unassigned-station" | string;

export function useKitchenTickets(stationId: string | "all" = "all", view: QueueView = "live") {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();

  const query = useQuery({
    queryKey: [...KITCHEN_TICKETS_QUERY_KEY, organizationId, branchId ?? "all", stationId, view],
    enabled: Boolean(organizationId),
    refetchInterval: 20_000,
    queryFn: async (): Promise<KitchenTicket[]> => {
      const { data, error } = await guardedRpc(supabase, "neo_kitchen_queue", {
        ...(branchId ? { _branch: branchId } : {}),
        ...(stationId && stationId !== "all" ? { _station: stationId } : {}),
        _view: view,
      });
      if (error) throw error;
      return ((data ?? []) as unknown as KitchenTicket[]).map((t) => ({
        ...t,
        status: canonicalTicketStatus(t.status),
        items: (t.items ?? []) as KitchenTicketItem[],
      }));
    },
  });

  const tickets = useMemo(() => query.data ?? [], [query.data]);
  return { ...query, tickets };
}

/** Live invalidation shared by both pages, so a move on either updates both. */
export function useKitchenTicketRealtime() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: KITCHEN_TICKETS_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: ["kitchen", "ops-metrics"] });
    void qc.invalidateQueries({ queryKey: ["kitchen", "ticket-audit"] });
  };
  useScopedRealtime("kitchen-tickets-live", [
    { table: "station_tickets", onChange: invalidate },
    { table: "station_ticket_items", onChange: invalidate },
    { table: "pos_order_items", onChange: invalidate },
    { table: "station_ticket_status_history", onChange: invalidate },
  ]);
}

/* ------------------------------------------------------------------ *
 * Write — one server-enforced transition contract
 * ------------------------------------------------------------------ */

/**
 * Immediate feedback contract for a lifecycle move.
 *
 * The server stays authoritative, but the board must not look frozen while it
 * answers. Every transition therefore:
 *   1. paints the new status into the cached queue the instant it is sent,
 *   2. keeps the mutation "pending" until the refreshed queue has arrived, so
 *      the button stays disabled and a second tap cannot repeat the move,
 *   3. rolls the paint back and says why if the server refuses.
 */
type CachedQueue = KitchenTicket[] | undefined;

function patchCachedTickets(
  qc: ReturnType<typeof useQueryClient>,
  apply: (ticket: KitchenTicket) => KitchenTicket,
) {
  return qc
    .getQueriesData<CachedQueue>({ queryKey: KITCHEN_TICKETS_QUERY_KEY })
    .map(([key, data]) => {
      if (Array.isArray(data)) qc.setQueryData(key, data.map(apply));
      return [key, data] as const;
    });
}

function restoreCachedTickets(
  qc: ReturnType<typeof useQueryClient>,
  snapshot: readonly (readonly [readonly unknown[], CachedQueue])[] | undefined,
) {
  for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
}

/** Refresh everything the move touches, and wait for it before settling. */
async function settleTicketQueries(qc: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: KITCHEN_TICKETS_QUERY_KEY }),
    qc.invalidateQueries({ queryKey: ["kitchen"] }),
    qc.invalidateQueries({ queryKey: ["pos"] }),
  ]);
}

export function useKitchenTicketTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ticketId,
      to,
      reason,
    }: {
      ticketId: string;
      to: string;
      reason?: string;
    }) => {
      const { data, error } = await guardedRpc(supabase, "neo_kitchen_ticket_transition", {
        _ticket: ticketId,
        _to: to,
        ...(reason ? { _reason: reason } : {}),
      });
      if (error) throw error;
      return data;
    },
    onMutate: async ({ ticketId, to }) => {
      await qc.cancelQueries({ queryKey: KITCHEN_TICKETS_QUERY_KEY });
      const snapshot = patchCachedTickets(qc, (t) =>
        t.ticket_id === ticketId ? { ...t, status: canonicalTicketStatus(to) } : t,
      );
      return { snapshot };
    },
    onError: (e: Error, _vars, ctx) => {
      restoreCachedTickets(qc, ctx?.snapshot);
      toast.error(e.message);
    },
    onSuccess: (_data, { to }) => {
      toast.success(`Ticket moved to ${TICKET_ACTION_LABELS[to] ?? to}.`);
    },
    onSettled: () => settleTicketQueries(qc),
  });
}

export function useKitchenItemTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, to, reason }: { itemId: string; to: string; reason?: string }) => {
      const { data, error } = await guardedRpc(supabase, "neo_kitchen_item_transition", {
        _item: itemId,
        _to: to,
        ...(reason ? { _reason: reason } : {}),
      });
      if (error) throw error;
      return data;
    },
    onMutate: async ({ itemId, to }) => {
      await qc.cancelQueries({ queryKey: KITCHEN_TICKETS_QUERY_KEY });
      const snapshot = patchCachedTickets(qc, (t) => ({
        ...t,
        items: (t.items ?? []).map((i) => (i.ticket_item_id === itemId ? { ...i, status: to } : i)),
      }));
      return { snapshot };
    },
    onError: (e: Error, _vars, ctx) => {
      restoreCachedTickets(qc, ctx?.snapshot);
      toast.error(e.message);
    },
    onSuccess: () => toast.success("Item updated."),
    onSettled: () => settleTicketQueries(qc),
  });
}

export function useKitchenTicketDelay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ticketId, reason }: { ticketId: string; reason: string }) => {
      const { error } = await guardedRpc(supabase, "neo_kitchen_ticket_delay", {
        _ticket: ticketId,
        _reason: reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Delay recorded against the ticket.");
      void qc.invalidateQueries({ queryKey: KITCHEN_TICKETS_QUERY_KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Bulk actions — one server call, each ticket/item applied atomically
 * ------------------------------------------------------------------ */

export type BulkResult = { succeeded: number; failed: { error: string }[] };

function reportBulk(res: BulkResult, noun: string) {
  const failed = res?.failed ?? [];
  if (res?.succeeded) toast.success(`${res.succeeded} ${noun} advanced.`);
  if (failed.length) toast.error(`${failed.length} refused: ${failed[0]?.error ?? "not eligible"}`);
  if (!res?.succeeded && !failed.length) toast.info("Nothing eligible to advance.");
}

/** Which tickets in a selection can legally take this transition. */
export function eligibleTickets(tickets: KitchenTicket[], to: string) {
  return tickets.filter((t) => (TICKET_TRANSITIONS[t.status] ?? []).includes(to));
}

export function useKitchenBulkTicketTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ticketIds,
      to,
      reason,
    }: {
      ticketIds: string[];
      to: string;
      reason?: string;
    }) => {
      const { data, error } = await guardedRpc(supabase, "neo_kitchen_bulk_ticket_transition", {
        _tickets: ticketIds,
        _to: to,
        ...(reason ? { _reason: reason } : {}),
      });
      if (error) throw error;
      return data as unknown as BulkResult;
    },
    onSuccess: (res) => {
      reportBulk(res, "ticket(s)");
      void qc.invalidateQueries({ queryKey: KITCHEN_TICKETS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useKitchenBulkItemTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      itemIds,
      to,
      reason,
    }: {
      itemIds: string[];
      to: string;
      reason?: string;
    }) => {
      const { data, error } = await guardedRpc(supabase, "neo_kitchen_bulk_item_transition", {
        _items: itemIds,
        _to: to,
        ...(reason ? { _reason: reason } : {}),
      });
      if (error) throw error;
      return data as unknown as BulkResult;
    },
    onSuccess: (res) => {
      reportBulk(res, "item(s)");
      void qc.invalidateQueries({ queryKey: KITCHEN_TICKETS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Operations metrics + per-ticket audit
 * ------------------------------------------------------------------ */

export type StationWorkload = {
  station_id: string | null;
  station_name: string;
  open_tickets: number;
  delayed_tickets: number;
  oldest_minutes: number;
  avg_prep_minutes: number | null;
  completed_24h: number;
};

export type KitchenOpsMetrics = {
  open_tickets: number;
  delayed_tickets: number;
  avg_prep_minutes: number | null;
  backlog_by_status: { status: string; count: number }[];
  stations: StationWorkload[];
};

export function useKitchenOpsMetrics() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["kitchen", "ops-metrics", organizationId, branchId ?? "all"],
    enabled: Boolean(organizationId),
    refetchInterval: 30_000,
    queryFn: async (): Promise<KitchenOpsMetrics> => {
      const { data, error } = await guardedRpc(
        supabase,
        "neo_kitchen_ops_metrics",
        branchId ? { _branch: branchId } : {},
      );
      if (error) throw error;
      const m = (data ?? {}) as unknown as Partial<KitchenOpsMetrics>;
      return {
        open_tickets: m.open_tickets ?? 0,
        delayed_tickets: m.delayed_tickets ?? 0,
        avg_prep_minutes: m.avg_prep_minutes ?? null,
        backlog_by_status: m.backlog_by_status ?? [],
        stations: m.stations ?? [],
      };
    },
  });
}

export type TicketAuditEvent = {
  id: string;
  created_at: string;
  scope: "ticket" | "item" | string;
  item_name: string | null;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  actor_name: string | null;
};

export function useKitchenTicketAudit(ticketId: string | null) {
  return useQuery({
    queryKey: ["kitchen", "ticket-audit", ticketId],
    enabled: Boolean(ticketId),
    queryFn: async (): Promise<TicketAuditEvent[]> => {
      const { data, error } = await guardedRpc(supabase, "neo_kitchen_ticket_audit", {
        _ticket: ticketId as string,
      });
      if (error) throw error;
      return (data ?? []) as unknown as TicketAuditEvent[];
    },
  });
}

/** Idempotent recovery for POS orders whose production tickets were never created. */
export function useKitchenTicketBackfill() {
  const qc = useQueryClient();
  const { branchId } = useActivePropertyFilter();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(
        supabase,
        "neo_kitchen_backfill_tickets",
        branchId ? { _branch: branchId } : {},
      );
      if (error) throw error;
      return data as { orders_processed?: number; items_routed?: number } | null;
    },
    onSuccess: (res) => {
      toast.success(
        `Reconciled ${res?.orders_processed ?? 0} order(s), ${res?.items_routed ?? 0} item(s) routed.`,
      );
      void qc.invalidateQueries({ queryKey: KITCHEN_TICKETS_QUERY_KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Re-partitions historical tickets onto their resolved production stations. */
export function useKitchenStationReconcile() {
  const qc = useQueryClient();
  const { branchId } = useActivePropertyFilter();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_kitchen_reconcile_stations", {
        ...(branchId ? { _branch: branchId } : {}),
      });
      if (error) throw error;
      return data as {
        tickets_assigned?: number;
        partitions_created?: number;
        items_moved?: number;
        items_without_routing?: number;
      } | null;
    },
    onSuccess: (res) => {
      toast.success(
        `Reconciled ${res?.tickets_assigned ?? 0} ticket(s), created ${res?.partitions_created ?? 0} station partition(s); ` +
          `${res?.items_without_routing ?? 0} item(s) still have no routing.`,
      );
      void qc.invalidateQueries({ queryKey: KITCHEN_TICKETS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Station selector — scoped, never wider than the user's own scope
 * ------------------------------------------------------------------ */

export type ScopedStations = {
  stations: { id: string; name: string; code?: string | null; station_type?: string | null }[];
  /** False for station-scoped users: they may not select "All stations". */
  allowAll: boolean;
  isLoading: boolean;
  error: Error | null;
};

export function useScopedStations(): ScopedStations {
  const { organizationId, user } = useAuth();
  const { branchId } = useActivePropertyFilter();

  const scope = useQuery({
    queryKey: ["kitchen", "access-scope", organizationId, user?.id],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "current_access_scope");
      if (error) throw error;
      return (data as string | null) ?? "organisation";
    },
  });

  const stations = useQuery({
    queryKey: ["kitchen", "scoped-stations", organizationId, user?.id, branchId ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase
        .from("operational_stations")
        .select("id, name, branch_id, code, station_type")
        .eq("organization_id", organizationId as string)
        .eq("active", true)
        .order("sort_order")
        .order("name");
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const mine = useQuery({
    queryKey: ["kitchen", "my-station-ids", organizationId, user?.id],
    enabled: Boolean(organizationId && user?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_stations")
        .select("station_id")
        .eq("user_id", user?.id as string);
      if (error) throw error;
      return (data ?? []).map((r) => (r as { station_id: string }).station_id);
    },
  });

  const visible = useQuery({
    queryKey: ["kitchen", "visible-station-ids", organizationId, user?.id, branchId],
    enabled: Boolean(organizationId && user?.id),
    queryFn: async () => {
      const { data, error } = await guardedRpc<string[]>(supabase, "neo_kitchen_visible_station_ids");
      if (error) throw error;
      return data ?? [];
    },
  });

  const loaded = Boolean(organizationId && scope.isSuccess && stations.isSuccess && mine.isSuccess && visible.isSuccess);
  const stationScoped = scope.data === "station";
  const list = stationScoped
    ? (stations.data ?? []).filter((s) => (mine.data ?? []).includes(s.id))
    : (stations.data ?? []);

  return {
    stations: loaded ? list.filter((station) => visible.data?.includes(station.id)) : [],
    allowAll: loaded && !stationScoped,
    isLoading: scope.isLoading || stations.isLoading || mine.isLoading || visible.isLoading,
    error: (scope.error || stations.error || mine.error || visible.error) as Error | null,
  };
}

/* ------------------------------------------------------------------ *
 * Station authority — who may ACT on a ticket, not merely watch it
 * ------------------------------------------------------------------ */

/**
 * Raising an order lets a waiter watch its tickets so service knows where the
 * food is; it does not make them a cook. Production moves (accept, start,
 * finish) and cancellation belong to the station the ticket sits on — the
 * database enforces exactly this rule in
 * `neo_kitchen_assert_station_authority`, and this hook keeps the screens
 * honest so a control is never offered that the backend would refuse.
 */
export function useStationAuthority() {
  const { organizationId, user, can } = useAuth();
  const allStations = can("kitchen", "all_stations", "view");

  const mine = useQuery({
    queryKey: ["kitchen", "my-station-ids", organizationId, user?.id],
    enabled: Boolean(organizationId && user?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_stations")
        .select("station_id")
        .eq("user_id", user?.id as string);
      if (error) throw error;
      return (data ?? []).map((r) => (r as { station_id: string }).station_id);
    },
  });

  const myStationIds = mine.data ?? [];
  return {
    myStationIds,
    /** True when the person may run production on this ticket's station. */
    canWorkStation: (stationId: string | null | undefined) =>
      allStations || (stationId != null && myStationIds.includes(stationId)),
    isLoading: mine.isLoading,
  };
}
