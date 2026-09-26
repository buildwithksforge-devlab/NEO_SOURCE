/**
 * Stock need lifecycle.
 *
 * A need is one idea however it arose: a department reported it, or stock fell
 * to its reorder point. From the moment it is reported it has somewhere to go —
 * issue it from a store in full or in part, or route what cannot be covered to
 * Procurement as a purchase request. The lineage is kept, so "HR asked for 15
 * reams — what happened?" always has an answer.
 *
 * Routing to Procurement reuses an already-active request for the same need
 * instead of raising a second one, so repeated clicks cannot multiply demand.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { applyStockNeedStatus, normaliseNeedRow } from "@/lib/stock-needs";

// The needs trail joins departments, items and purchase requests; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type NeedRow = Record<string, unknown>;

export function newNeedAttemptKey(): string {
  return crypto.randomUUID();
}

function useNeedsInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["stock-needs"] });
    void qc.invalidateQueries({ queryKey: ["stores-department"] });
    void qc.invalidateQueries({ queryKey: ["inventory"] });
    void qc.invalidateQueries({ queryKey: ["procurement"] });
  };
}

/** Every reported or system-raised need for the selected property. */
export function useStockNeeds(status: "open" | "all" = "open") {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["stock-needs", "list", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("department_stock_needs")
        .select(
          "id, item, quantity, unit, priority, status, notes, origin, created_at, fulfilled_quantity, stock_item_id, purchase_request_id, department_id, departments(name), stock_items(name, base_unit), purchase_requests(request_number, status)",
        )
        .order("created_at", { ascending: false })
        .limit(200);
      // Needs reported before property scoping existed carry no branch; they are
      // still this workspace's needs, so a property view must not hide them.
      if (branchId) q = q.or(`branch_id.eq.${branchId},branch_id.is.null`);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return ((data ?? []) as NeedRow[]).map(normaliseNeedRow);
    },
  });
}

/** Point a reported need at a real catalogue item so it can be issued. */
export function useLinkNeedItem() {
  const invalidate = useNeedsInvalidate();
  return useMutation({
    mutationFn: async ({ needId, stockItemId }: { needId: string; stockItemId: string }) => {
      const { data, error } = await guardedRpc(db, "neo_stock_need_link_item", {
        _need: needId,
        _stock_item: stockItemId,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Need linked to a stock item.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Issue against a need, in full or in part, from a chosen store. */
export function useFulfilNeed() {
  const invalidate = useNeedsInvalidate();
  return useMutation({
    mutationFn: async (input: {
      needId: string;
      locationId: string;
      quantity: number;
      attemptKey: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_stock_need_fulfil", {
        _need: input.needId,
        _location: input.locationId,
        _quantity: input.quantity,
        _attempt: input.attemptKey,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: (data) => {
      invalidate();
      if (data["replayed"] === true) toast.info("Already issued — showing the original result.");
      else if (String(data["status"] ?? "") === "requisitioned")
        toast.success("Issued in full — the need is closed.");
      else toast.success("Part of the need was issued; the balance is still outstanding.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Send the outstanding balance to Procurement, reusing any active request. */
export function useRouteNeedToProcurement() {
  const invalidate = useNeedsInvalidate();
  return useMutation({
    mutationFn: async ({ needId, notes }: { needId: string; notes?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_stock_need_to_procurement", {
        _need: needId,
        _notes: notes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: (data) => {
      invalidate();
      if (data["duplicate"] === true)
        toast.info("A purchase request is already open for this need.");
      else
        toast.success(
          `Routed to Procurement as ${String(data["request_number"] ?? "a purchase request")}.`,
        );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
