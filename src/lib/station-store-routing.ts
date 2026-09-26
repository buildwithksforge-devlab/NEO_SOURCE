/**
 * Station → supply store routing.
 *
 * One mapping decides where a sold dish, drink or pastry takes its stock
 * from. Every surface that deducts stock — restaurant till, kitchen display,
 * bar queue, pastry production, recipes, wastage and reversals — resolves
 * through the same database routine, so this screen and the deduction can
 * never disagree. Nothing is chosen on the property's behalf.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export type StationState =
  | "ready"
  | "needs_setup"
  | "store_inactive"
  | "cross_property"
  | "no_production";

export type StationConsoleRow = {
  stationId: string;
  stationName: string;
  stationCode: string | null;
  stationType: string;
  departmentName: string | null;
  branchId: string | null;
  locationId: string | null;
  locationName: string | null;
  locationActive: boolean;
  mappedExplicitly: boolean;
  recipesActive: number;
  directItems: number;
  routedItems: number;
  changedAt: string | null;
  changedByName: string | null;
  state: StationState;
};

export const STATION_STATE_LABEL: Record<StationState, string> = {
  ready: "Ready",
  needs_setup: "Needs setup",
  store_inactive: "Store inactive",
  cross_property: "Cross-property mismatch",
  no_production: "No recipes or menu items yet",
};

type Raw = Record<string, unknown>;

export function useStationStoreConsole() {
  const { organizationId } = useAuth();
  const { branchId, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["kitchen", "station-store-console", organizationId, branchId ?? "all", filterKey],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<StationConsoleRow[]> => {
      const { data, error } = await guardedRpc(supabase as never, "neo_station_store_console", {
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Raw[]).map((r) => ({
        stationId: String(r["station_id"]),
        stationName: String(r["station_name"] ?? "Station"),
        stationCode: (r["station_code"] as string | null) ?? null,
        stationType: String(r["station_type"] ?? "service"),
        departmentName: (r["department_name"] as string | null) ?? null,
        branchId: (r["branch_id"] as string | null) ?? null,
        locationId: (r["location_id"] as string | null) ?? null,
        locationName: (r["location_name"] as string | null) ?? null,
        locationActive: Boolean(r["location_active"]),
        mappedExplicitly: Boolean(r["mapped_explicitly"]),
        recipesActive: Number(r["recipes_active"] ?? 0),
        directItems: Number(r["direct_items"] ?? 0),
        routedItems: Number(r["routed_items"] ?? 0),
        changedAt: (r["changed_at"] as string | null) ?? null,
        changedByName: (r["changed_by_name"] as string | null) ?? null,
        state: String(r["state"] ?? "needs_setup") as StationState,
      }));
    },
  });
}

/** Only active stores of the same property may ever be offered. */
export function usePropertyStores(branchIdOverride?: string | null) {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const property = branchIdOverride ?? branchId ?? null;
  return useQuery({
    queryKey: ["kitchen", "property-stores", organizationId, property ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase
        .from("stock_locations")
        .select("id, name, code, location_type, branch_id, active")
        .eq("active", true)
        .order("name");
      if (property) q = q.or(`branch_id.eq.${property},branch_id.is.null`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as {
        id: string;
        name: string;
        code: string | null;
        location_type: string | null;
        branch_id: string | null;
        active: boolean;
      }[];
    },
  });
}

export type StationImpact = {
  allowed: boolean;
  reason?: string | undefined;
  stationName?: string | undefined;
  recipes: { id: string; name: string }[];
  menuItems: { id: string; name: string }[];
};

export function useStationImpact(stationId: string | null) {
  return useQuery({
    queryKey: ["kitchen", "station-impact", stationId],
    enabled: Boolean(stationId),
    queryFn: async (): Promise<StationImpact> => {
      const { data, error } = await guardedRpc(supabase as never, "neo_station_store_impact", {
        _station: stationId,
      });
      if (error) throw new Error(error.message);
      const r = (data ?? {}) as Raw;
      return {
        allowed: Boolean(r["allowed"]),
        reason: (r["reason"] as string | undefined) ?? undefined,
        stationName: (r["station_name"] as string | undefined) ?? undefined,
        recipes: (r["recipes"] as { id: string; name: string }[] | null) ?? [],
        menuItems: (r["menu_items"] as { id: string; name: string }[] | null) ?? [],
      };
    },
  });
}

function useRefreshRouting() {
  const qc = useQueryClient();
  return () => {
    // Kitchen settings, recipe readiness and menu routing all read the same
    // mapping, so one change refreshes all of them at once.
    void qc.invalidateQueries({ queryKey: ["kitchen"] });
    void qc.invalidateQueries({ queryKey: ["inventory"] });
    void qc.invalidateQueries({ queryKey: ["menu"] });
    void qc.invalidateQueries({ queryKey: ["pos"] });
  };
}

export function useSetStationStore() {
  const refresh = useRefreshRouting();
  return useMutation({
    mutationFn: async (input: { stationId: string; locationId: string; reason?: string | undefined }) => {
      const { data, error } = await guardedRpc(supabase as never, "neo_station_store_set", {
        _station: input.stationId,
        _location: input.locationId,
        _reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      return data as Raw;
    },
    onSuccess: (data) => {
      toast.success(`Supply store set to ${String(data?.["location_name"] ?? "the chosen store")}.`);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useClearStationStore() {
  const refresh = useRefreshRouting();
  return useMutation({
    mutationFn: async (input: { stationId: string; reason?: string | undefined }) => {
      const { data, error } = await guardedRpc(supabase as never, "neo_station_store_clear", {
        _station: input.stationId,
        _reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      return data as Raw;
    },
    onSuccess: () => {
      toast.success("Mapping removed.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Page-level summary, computed from the same rows the table shows. */
export function summariseStations(rows: StationConsoleRow[]) {
  const ready = rows.filter((r) => r.state === "ready").length;
  const needsSetup = rows.filter(
    (r) => r.state === "needs_setup" || r.state === "store_inactive" || r.state === "cross_property",
  ).length;
  const recipes = rows.reduce((n, r) => n + r.recipesActive, 0);
  const routedItems = rows.reduce((n, r) => n + r.directItems + r.routedItems, 0);
  const blocked = rows
    .filter((r) => r.state !== "ready" && r.state !== "no_production")
    .reduce((n, r) => n + r.directItems + r.routedItems, 0);
  return { total: rows.length, ready, needsSetup, recipes, routedItems, blocked };
}

export type StationRoutingRule = {
  id: string;
  stationName: string;
  subject: string;
  priority: number;
  active: boolean;
};

/** Category/item routing rules, shaped for display. */
export function useStationStoreRules() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["kitchen", "routing-rules-view", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<StationRoutingRule[]> => {
      const { data, error } = await supabase
        .from("station_routing_rules")
        .select(
          "id, priority, active, operational_stations!station_routing_rules_station_id_fkey(name), menu_items(name), menu_categories(name)",
        )
        .order("priority");
      if (error) throw error;
      return ((data ?? []) as unknown as Raw[]).map((r) => ({
        id: String(r["id"]),
        stationName: String(
          (r["operational_stations"] as Raw | null)?.["name"] ?? "Station",
        ),
        subject: String(
          (r["menu_items"] as Raw | null)?.["name"] ??
            (r["menu_categories"] as Raw | null)?.["name"] ??
            "All items",
        ),
        priority: Number(r["priority"] ?? 0),
        active: r["active"] !== false,
      }));
    },
  });
}
