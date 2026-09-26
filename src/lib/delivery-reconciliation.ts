/**
 * Delivery-against-ledger reconciliation.
 *
 * Before a receipt is posted, what physically arrived is compared line by line
 * against what the purchase order still expects and against the quantity the
 * stock ledger currently holds in the receiving store. Nothing here writes: it
 * only states the variance so a shortage or an overage is seen — and
 * acknowledged — before the delivery is completed.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import type { Row } from "@/lib/inventory";
import { outstandingOf } from "@/lib/stores-lifecycle";

const EPSILON = 0.0001;

export type DeliveryVariance = "match" | "short" | "over" | "rejected" | "not-delivered";

export type DeliveryReconciliationLine = {
  lineId: string;
  itemId: string | null;
  name: string;
  unit: string;
  ordered: number;
  outstanding: number;
  delivered: number;
  rejected: number;
  accepted: number;
  variance: number;
  status: DeliveryVariance;
  ledgerBefore: number | null;
  ledgerAfter: number | null;
};

export type DeliveryReconciliation = {
  lines: DeliveryReconciliationLine[];
  shortages: DeliveryReconciliationLine[];
  overages: DeliveryReconciliationLine[];
  rejections: DeliveryReconciliationLine[];
  hasExceptions: boolean;
  deliveredLines: number;
};

/** Quantity the ledger currently holds for these items in one store. */
export function useLedgerOnHand(itemIds: string[], locationId: string | null) {
  const { organizationId } = useAuth();
  const key = [...itemIds].sort().join(",");
  return useQuery({
    queryKey: ["inventory", "ledger-on-hand", organizationId, locationId ?? "none", key],
    enabled: Boolean(organizationId) && Boolean(locationId) && itemIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_levels")
        .select("stock_item_id, quantity_on_hand, location_id")
        .eq("location_id", locationId as string)
        .in("stock_item_id", itemIds);
      if (error) throw new Error(error.message);
      const map: Record<string, number> = {};
      for (const row of (data ?? []) as unknown as Row[]) {
        map[String(row["stock_item_id"])] = Number(row["quantity_on_hand"] ?? 0) || 0;
      }
      return map;
    },
  });
}

function classify(delivered: number, outstanding: number, rejected: number): DeliveryVariance {
  if (delivered <= EPSILON) return "not-delivered";
  if (delivered > outstanding + EPSILON) return "over";
  if (delivered < outstanding - EPSILON) return "short";
  if (rejected > EPSILON) return "rejected";
  return "match";
}

export function reconcileDelivery(
  lines: Row[],
  quantities: Record<string, string>,
  rejected: Record<string, string>,
  onHand: Record<string, number> | undefined,
): DeliveryReconciliation {
  const rows = lines.map((line): DeliveryReconciliationLine => {
    const lineId = String(line["id"]);
    const itemId = line["stock_item_id"] ? String(line["stock_item_id"]) : null;
    const delivered = Math.max(Number(quantities[lineId] ?? 0) || 0, 0);
    const rejectedQty = Math.max(Number(rejected[lineId] ?? 0) || 0, 0);
    const accepted = Math.max(delivered - rejectedQty, 0);
    const outstanding = outstandingOf(line);
    const before = itemId && onHand ? (onHand[itemId] ?? 0) : null;
    return {
      lineId,
      itemId,
      name: String((line["stock_items"] as Row | null)?.["name"] ?? line["description"] ?? "Item"),
      unit: String((line["stock_items"] as Row | null)?.["base_unit"] ?? line["unit"] ?? ""),
      ordered: Number(line["quantity"] ?? 0) || 0,
      outstanding,
      delivered,
      rejected: rejectedQty,
      accepted,
      variance: Number((delivered - outstanding).toFixed(4)),
      status: classify(delivered, outstanding, rejectedQty),
      ledgerBefore: before,
      ledgerAfter: before === null ? null : Number((before + accepted).toFixed(4)),
    };
  });

  const delivered = rows.filter((r) => r.status !== "not-delivered");
  const shortages = delivered.filter((r) => r.status === "short");
  const overages = delivered.filter((r) => r.status === "over");
  const rejections = delivered.filter((r) => r.rejected > EPSILON);

  return {
    lines: rows,
    shortages,
    overages,
    rejections,
    hasExceptions: shortages.length > 0 || overages.length > 0 || rejections.length > 0,
    deliveredLines: delivered.length,
  };
}

export function varianceLabel(status: DeliveryVariance): string {
  return {
    match: "Matches order",
    short: "Short delivery",
    over: "Over delivery",
    rejected: "Partly rejected",
    "not-delivered": "Not delivered",
  }[status];
}

export function varianceTone(
  status: DeliveryVariance,
): "default" | "success" | "warning" | "info" | "destructive" {
  switch (status) {
    case "match":
      return "success";
    case "short":
      return "warning";
    case "over":
      return "destructive";
    case "rejected":
      return "warning";
    default:
      return "default";
  }
}
