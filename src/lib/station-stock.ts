/**
 * Station stock.
 *
 * A station (Hot Kitchen, Main Bar, Pastry) consumes from the store it is
 * mapped to in `station_consumption_stores`. This layer reads — never writes —
 * the balances of that store, the reorder alerts derived from the recorded
 * reorder point, and the stock movements POS tickets have already caused.
 *
 * Nothing is inferred: an item without a recorded reorder point is reported as
 * unconfigured rather than given an invented threshold, and a station without
 * a mapped store is reported as unmapped rather than shown another store's
 * balances.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { num, stockHealth, type StockHealth } from "@/lib/inventory";

// The station trail spans several generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Raw = Record<string, unknown>;

export type MyStation = {
  stationId: string;
  stationName: string;
  stationType: string;
  isPrimary: boolean;
};

export type StationStockRow = {
  itemId: string;
  name: string;
  unit: string;
  onHand: number;
  reserved: number;
  reorderPoint: number | null;
  parLevel: number | null;
  health: StockHealth;
  lastMovementAt: string | null;
};

export type StationConsumptionRow = {
  id: string;
  itemName: string;
  quantity: number;
  unit: string;
  movementType: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
};

/** The stations this signed-in person is actually assigned to. */
export function useMyStations() {
  const { user, organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const userId = user?.id ?? null;
  return useQuery({
    queryKey: ["station-stock", "my-stations", organizationId, branchId, userId],
    enabled: Boolean(organizationId && userId),
    queryFn: async (): Promise<MyStation[]> => {
      let q = db
        .from("user_stations")
        .select("station_id, is_primary, operational_stations(name, station_type, active)")
        .eq("user_id", userId);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Raw[];
      return rows
        .map((r) => {
          const station = (r["operational_stations"] as Raw | null) ?? null;
          return {
            stationId: String(r["station_id"] ?? ""),
            stationName: String(station?.["name"] ?? "Station"),
            stationType: String(station?.["station_type"] ?? "service"),
            isPrimary: Boolean(r["is_primary"]),
          };
        })
        .filter((s) => s.stationId !== "")
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.stationName.localeCompare(b.stationName));
    },
  });
}

/** The store locations a station draws from. Empty means the mapping is missing. */
export function useStationStores(stationId: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["station-stock", "stores", organizationId, stationId],
    enabled: Boolean(organizationId && stationId),
    queryFn: async (): Promise<{ locationId: string; locationName: string }[]> => {
      const { data, error } = await db
        .from("station_consumption_stores")
        .select("location_id, stock_locations(name)")
        .eq("station_id", stationId);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Raw[])
        .map((r) => ({
          locationId: String(r["location_id"] ?? ""),
          locationName: String((r["stock_locations"] as Raw | null)?.["name"] ?? "Store"),
        }))
        .filter((r) => r.locationId !== "");
    },
  });
}

/** Ingredient balances held in the station's own store. */
export function useStationStockLevels(locationIds: string[]) {
  const { organizationId } = useAuth();
  const key = locationIds.slice().sort().join(",");
  return useQuery({
    queryKey: ["station-stock", "levels", organizationId, key],
    enabled: Boolean(organizationId) && locationIds.length > 0,
    queryFn: async (): Promise<StationStockRow[]> => {
      const { data, error } = await db
        .from("stock_levels")
        .select(
          "stock_item_id, quantity_on_hand, quantity_reserved, last_movement_at, stock_items(name, base_unit, reorder_point, min_level, par_level, active)",
        )
        .in("location_id", locationIds)
        .limit(2000);
      if (error) throw new Error(error.message);
      const merged = new Map<string, StationStockRow>();
      for (const raw of (data ?? []) as Raw[]) {
        const item = (raw["stock_items"] as Raw | null) ?? null;
        if (!item || item["active"] === false) continue;
        const id = String(raw["stock_item_id"] ?? "");
        if (!id) continue;
        const reorderPoint =
          item["reorder_point"] === null || item["reorder_point"] === undefined
            ? item["min_level"] === null || item["min_level"] === undefined
              ? null
              : num(item["min_level"])
            : num(item["reorder_point"]);
        const parLevel =
          item["par_level"] === null || item["par_level"] === undefined ? null : num(item["par_level"]);
        const onHand = num(raw["quantity_on_hand"]);
        const existing = merged.get(id);
        const lastMovementAt = (raw["last_movement_at"] as string | null) ?? null;
        if (existing) {
          existing.onHand += onHand;
          existing.reserved += num(raw["quantity_reserved"]);
          existing.health = stockHealth(existing.onHand, reorderPoint ?? 0, parLevel);
          if (lastMovementAt && (!existing.lastMovementAt || lastMovementAt > existing.lastMovementAt)) {
            existing.lastMovementAt = lastMovementAt;
          }
          continue;
        }
        merged.set(id, {
          itemId: id,
          name: String(item["name"] ?? "Ingredient"),
          unit: String(item["base_unit"] ?? ""),
          onHand,
          reserved: num(raw["quantity_reserved"]),
          reorderPoint,
          parLevel,
          health: stockHealth(onHand, reorderPoint ?? 0, parLevel),
          lastMovementAt,
        });
      }
      return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}

/** Movements POS service has already caused in the station's store. */
export function useStationConsumption(locationIds: string[]) {
  const { organizationId } = useAuth();
  const key = locationIds.slice().sort().join(",");
  return useQuery({
    queryKey: ["station-stock", "consumption", organizationId, key],
    enabled: Boolean(organizationId) && locationIds.length > 0,
    queryFn: async (): Promise<StationConsumptionRow[]> => {
      const { data, error } = await db
        .from("stock_movements")
        .select("id, quantity, unit, movement_type, reference_type, reference_id, created_at, stock_items(name)")
        .in("location_id", locationIds)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Raw[]).map((r) => ({
        id: String(r["id"]),
        itemName: String((r["stock_items"] as Raw | null)?.["name"] ?? "Ingredient"),
        quantity: num(r["quantity"]),
        unit: String(r["unit"] ?? ""),
        movementType: String(r["movement_type"] ?? "movement"),
        referenceType: (r["reference_type"] as string | null) ?? null,
        referenceId: (r["reference_id"] as string | null) ?? null,
        createdAt: String(r["created_at"] ?? ""),
      }));
    },
  });
}

/** Items at or below their recorded reorder point. Unconfigured items are excluded. */
export function reorderAlerts(rows: StationStockRow[]): StationStockRow[] {
  return rows.filter((r) => r.reorderPoint !== null && r.onHand <= r.reorderPoint);
}

export function unconfiguredItems(rows: StationStockRow[]): StationStockRow[] {
  return rows.filter((r) => r.reorderPoint === null);
}
