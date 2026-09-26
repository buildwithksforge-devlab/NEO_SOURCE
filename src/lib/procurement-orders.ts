/**
 * Purchase order board.
 *
 * One read that carries every purchase order with its lines and the deliveries
 * already booked against it, so a buyer can see ordered / received /
 * outstanding without a second query per order. Approval and closing go
 * through the same guarded database routines the rest of the chain uses; this
 * module never writes to purchase_orders directly.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import type { Row } from "@/lib/inventory";

// The procurement trail spans many generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type OrderStage = "awaiting_approval" | "open" | "partly_received" | "completed" | "cancelled";

export type OrderView = {
  id: string;
  number: string;
  status: string;
  stage: OrderStage;
  supplier: string;
  expected: string | null;
  overdue: boolean;
  total: number;
  ordered: number;
  received: number;
  /** Short-closed or cancelled balance — no longer awaiting delivery. */
  cancelled: number;
  /** Still genuinely awaiting delivery: ordered − received − cancelled. */
  outstanding: number;
  closeReason: string | null;
  closedAt: string | null;
  lines: Row[];
  receipts: Row[];
  raw: Row;
};

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

const CANCELLED = ["cancelled", "voided", "rejected"];
const AWAITING = ["draft", "pending_approval", "pending-approval"];
const DONE = ["closed", "completed", "received", "fully-received", "fully_received", "fully-invoiced", "invoiced", "paid"];

function stageOf(status: string, ordered: number, received: number): OrderStage {
  if (CANCELLED.includes(status)) return "cancelled";
  if (AWAITING.includes(status)) return "awaiting_approval";
  if (DONE.includes(status)) return "completed";
  if (received > 0 && received + 0.0001 < ordered) return "partly_received";
  if (ordered > 0 && received + 0.0001 >= ordered) return "completed";
  return "open";
}

/** Every purchase order in the active property scope, newest first. */
export function usePurchaseOrderBoard() {
  const { organizationId } = useAuth();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["procurement", "order-board", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<OrderView[]> => {
      const { data, error } = await applyTo(
        db
          .from("purchase_orders")
          .select(
            "*, suppliers(name, phone, email), departments(name), purchase_order_lines(*, stock_items(name, base_unit)), goods_receipts(id, grn_number, status, received_at, total_value, is_partial)",
          ),
        "purchase_orders",
      )
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw new Error(error.message);

      return ((data ?? []) as Row[]).map((o) => {
        const lines = ((o["purchase_order_lines"] as Row[] | null) ?? []).slice();
        const ordered = lines.reduce((s, l) => s + n(l["quantity"]), 0);
        // Accepted quantity is the truth once a delivery has been inspected;
        // received is only a fallback for lines booked before inspection.
        const received = lines.reduce(
          (s, l) => s + n(l["accepted_quantity"] ?? l["received_quantity"]),
          0,
        );
        // A short-closed or cancelled balance is settled, not awaiting delivery.
        const cancelled = lines.reduce((s, l) => s + n(l["cancelled_quantity"]), 0);
        const status = String(o["status"] ?? "draft");
        const expectedRaw = o["expected_date"] ? String(o["expected_date"]) : null;
        const stage = stageOf(status, ordered, received);
        return {
          id: String(o["id"]),
          number: String(o["order_number"] ?? "Purchase order"),
          status,
          stage,
          supplier: String((o["suppliers"] as Row | null)?.["name"] ?? "Supplier"),
          expected: expectedRaw,
          overdue:
            (stage === "open" || stage === "partly_received") &&
            expectedRaw !== null &&
            new Date(expectedRaw).getTime() < Date.now(),
          total: n(o["total_amount"]),
          ordered,
          received,
          cancelled,
          outstanding: Math.max(ordered - received - cancelled, 0),
          closeReason: (o["close_reason"] as string | null) ?? null,
          closedAt: (o["closed_at"] as string | null) ?? null,
          lines,
          receipts: ((o["goods_receipts"] as Row[] | null) ?? []).slice(),
          raw: o,
        };
      });
    },
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["procurement"] });
    void qc.invalidateQueries({ queryKey: ["inventory"] });
    void qc.invalidateQueries({ queryKey: ["reconciliation"] });
  };
}

/** Close an order that will not be delivered in full; a written reason is kept. */
export function useCloseOrder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ orderId, reason }: { orderId: string; reason: string }) => {
      const { data, error } = await guardedRpc(db, "neo_procurement_order_close", {
        _order: orderId,
        _reason: reason,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Purchase order closed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
