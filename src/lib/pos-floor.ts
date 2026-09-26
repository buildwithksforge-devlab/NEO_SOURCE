import type { FloorTableState } from "@/components/pos/FloorTableCard";

/**
 * Minutes of open service after which the floor flags a table for attention.
 * Kept here so the card, the inspector and the tests share one threshold.
 */
export const SERVICE_ATTENTION_MINUTES = 90;

type TableRow = {
  id: string;
  code: string;
  capacity: number | null;
  status: string;
  area_id?: string | null;
  restaurant_areas?: { name?: string | null } | null;
};

type OrderRow = {
  id: string;
  order_number: string;
  table_id: string | null;
  guest_count: number | null;
  status: string;
  grand_total: number | null;
  paid_total: number | null;
  currency?: string | null;
  created_at: string;
  profiles?: { full_name?: string | null } | null;
};
/**
 * Seating status implied by an open bill. Service progress is what the floor
 * reads, so a served-but-unsettled table is shown as awaiting payment rather
 * than as free seating.
 */
export function effectiveTableStatus(orderStatus: string): string {
  switch (orderStatus) {
    case "served":
    case "awaiting-payment":
    case "billed":
      return "bill-presented";
    default:
      return "occupied";
  }
}


/**
 * Joins the canonical open `pos_orders` rows onto the configured tables. A table
 * with no open bill gets no order block at all — the floor never shows a
 * placeholder figure for an unopened table.
 */
export function buildFloorState(
  tables: readonly TableRow[],
  openOrders: readonly OrderRow[],
  now: number = Date.now(),
): FloorTableState[] {
  const byTable = new Map<string, OrderRow>();
  for (const order of openOrders) {
    if (!order.table_id) continue;
    const existing = byTable.get(order.table_id);
    // Most recently opened bill wins if a table somehow carries more than one.
    if (!existing || new Date(order.created_at) > new Date(existing.created_at)) {
      byTable.set(order.table_id, order);
    }
  }

  return tables.map((table) => {
    const order = byTable.get(table.id);
    const base: FloorTableState = {
      id: table.id,
      code: table.code,
      areaName: table.restaurant_areas?.name ?? "Unassigned area",
      capacity: table.capacity ?? 0,
      // A table carrying an open bill is never "available", whatever the
      // configured seating status still says: the live order is the truth.
      status: order ? effectiveTableStatus(order.status) : table.status,
    };
    if (!order) return base;


    const elapsedMinutes = Math.max(
      0,
      Math.floor((now - new Date(order.created_at).getTime()) / 60_000),
    );
    const outstanding = Math.max(0, (order.grand_total ?? 0) - (order.paid_total ?? 0));
    return {
      ...base,
      order: {
        id: order.id,
        orderNumber: order.order_number,
        guestCount: order.guest_count ?? 0,
        waiterName: order.profiles?.full_name ?? null,
        status: order.status,
        outstanding,
        currency: order.currency ?? "KES",
        elapsedMinutes,
        needsAttention:
          elapsedMinutes >= SERVICE_ATTENTION_MINUTES ||
          (order.status === "ready" && elapsedMinutes >= 15),
      },
    };
  });
}

/** Headline counters for the floor summary strip — all derived, never guessed. */
export function summariseFloor(state: readonly FloorTableState[]) {
  const occupied = state.filter((t) => t.order).length;
  return {
    total: state.length,
    occupied,
    available: state.filter((t) => !t.order && t.status === "available").length,
    covers: state.reduce((sum, t) => sum + (t.order?.guestCount ?? 0), 0),
    attention: state.filter((t) => t.order?.needsAttention).length,
    outstanding: state.reduce((sum, t) => sum + (t.order?.outstanding ?? 0), 0),
  };
}
