/**
 * Cross-module integrity diagnostics.
 *
 * Both reports are computed in the database inside the caller's permission and
 * property scope: the browser never derives integrity from partial data.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase as sb } from "@/integrations/supabase/client";

export type ReconciliationGroup = { key: string; label: string; rows: Record<string, unknown>[] };

export type ReconciliationReport = {
  ok: boolean;
  healthy: boolean;
  generatedAt: string | null;
  groups: ReconciliationGroup[];
  total: number;
};

export function shapeReconciliationReport(data: unknown, labels: Record<string, string>): ReconciliationReport {
  const report = (data ?? {}) as Record<string, unknown>;
  const knownGroups = Object.entries(labels).map(([key, label]) => ({
    key,
    label,
    rows: Array.isArray(report[key]) ? (report[key] as Record<string, unknown>[]) : [],
  }));
  const unknownGroups = Object.entries(report)
    .filter(([key, value]) => !(key in labels) && Array.isArray(value) && value.length > 0)
    .map(([key, value]) => ({
      key,
      label: key.replace(/[-_]/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()),
      rows: value as Record<string, unknown>[],
    }));
  const groups = [...knownGroups, ...unknownGroups];
  const total = groups.reduce((sum, g) => sum + g.rows.length, 0);
  const ok = report["ok"] === true;
  return {
    ok,
    // "Reconciled" is a conclusion, and a conclusion needs a completed check
    // behind it. A report that did not run, or that still carries exception
    // rows, is never allowed to render as healthy — silence is not proof.
    healthy: ok && report["healthy"] === true && total === 0,
    generatedAt: (report["generated_at"] as string) ?? null,
    groups,
    total,
  };
}

export const POS_KDS_LABELS: Record<string, string> = {
  missing_tickets: "Sent items with no kitchen ticket",
  duplicate_sources: "Items with more than one live ticket",
  orphan_ticket_items: "Ticket lines with no source item",
  unassigned_station: "Sent items with no station resolved",
  status_conflicts: "POS says ready or served while the kitchen is still working",
  cancelled_still_active: "Cancelled or voided items still live in the kitchen",
};

export const PROCUREMENT_LABELS: Record<string, string> = {
  overdue_orders: "Approved orders past their expected date",
  receipts_not_in_stock: "Receipts not reflected in stock",
  stock_without_receipt: "Stock movements with no receipt document",
  negative_stock: "Negative stock balances",
  below_minimum: "Items at or below their minimum",
  duplicate_sources: "Stock movements claiming the same source twice",
  receipt_quantity_drift: "Ordered against received quantities that disagree",
};

export function usePosKdsReconciliation(branchId?: string | null) {
  return useQuery({
    queryKey: ["reconciliation", "pos-kds", branchId ?? "all"],
    queryFn: async () => {
      const { data, error } = await guardedRpc(sb, "neo_pos_kds_reconciliation", branchId ? { _branch: branchId } : {});
      if (error) throw new Error(error.message);
      return shapeReconciliationReport(data, POS_KDS_LABELS);
    },
    refetchInterval: 120_000,
  });
}

export function useProcurementReconciliation(branchId?: string | null) {
  return useQuery({
    queryKey: ["reconciliation", "procurement", branchId ?? "all"],
    queryFn: async () => {
      const { data, error } = await guardedRpc(sb, "neo_procurement_reconciliation", branchId ? { _branch: branchId } : {});
      if (error) throw new Error(error.message);
      return shapeReconciliationReport(data, PROCUREMENT_LABELS);
    },
    refetchInterval: 300_000,
  });
}

/**
 * Supervisor repair: rebuild kitchen tickets for kitchen-bound POS orders that
 * never reached the KDS. The database owns the routing — this only asks for it.
 */
export function useRouteMissingKitchenTickets(branchId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(sb, 
        "neo_pos_route_missing_tickets",
        branchId ? { _branch: branchId, _limit: 200 } : { _limit: 200 },
      );
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: (result) => {
      const orders = Number(result["orders_routed"] ?? 0);
      const tickets = Number(result["tickets_created"] ?? 0);
      toast.success(
        orders === 0
          ? "Every kitchen-bound order already holds its tickets."
          : `${orders} order(s) routed to the kitchen — ${tickets} ticket(s) created.`,
      );
      void qc.invalidateQueries({ queryKey: ["reconciliation", "pos-kds"] });
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
