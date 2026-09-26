import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import type { Row } from "@/lib/inventory";

const sel = (s: string): string => s;

function useCtx() {
  const { organizationId, profile, user } = useAuth();
  const { branchId: activeBranchId } = useActivePropertyFilter();
  return {
    organizationId,
    organization_id: organizationId as string,
    branch_id: activeBranchId ?? (profile as { branch_id?: string | null } | null)?.branch_id ?? null,
    userId: user?.id ?? null,
  };
}

/* ------------------------------ reads ------------------------------ */

export function useInventoryMetrics() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["inventory", "metrics", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "inventory_metrics", {});
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
  });
}

export function useReorderSuggestions() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["inventory", "reorder", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "inventory_reorder_suggestions");
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

/**
 * Replenishment recommendations raised automatically when a sale consumed a
 * stock item below its threshold.
 *
 * A recommendation is a signal to procurement — nothing here creates,
 * approves or places an order.
 */
export function useReplenishmentRecommendations() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["inventory", "replenishment-recommendations", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_replenishment_recommendations")
        .select("id, stock_item_id, branch_id, on_hand, threshold, recommended_quantity, source, status, created_at, stock_items(name, base_unit)")
        .eq("status", "recommended")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}


/**
 * Quantity a replenishment recommendation should buy: back up to the par
 * level, never merely to the reorder point. On hand 16 with a reorder point of
 * 20 and a par level of 50 buys 34.
 */
export function reorderQuantityFor(row: Row): number {
  const onHand = Number(row["on_hand"] ?? 0) || 0;
  const par = Number(row["par_level"] ?? 0) || 0;
  const suggested = Number(row["suggested_quantity"] ?? 0) || 0;
  const target = par > 0 ? par - onHand : suggested;
  return Math.max(Math.round((target + Number.EPSILON) * 1000) / 1000, 0);
}

/**
 * Raises a DRAFT purchase request for one item below its threshold. It never
 * orders anything: Procurement still reviews, sources and approves before any
 * purchase order exists. The canonical `purchase_requests` record is used —
 * there is no second requisition model.
 */
export function useRaiseReorderRequest() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (input: { item: Row; quantity: number; justification?: string }) => {
      const quantity = Number(input.quantity) || 0;
      if (quantity <= 0) throw new Error("Enter the quantity to request before raising it.");
      const itemId = String(input.item["id"] ?? "");
      if (!itemId) throw new Error("This recommendation has no stock item to request.");
      // A purchase request always belongs to one property. Viewing "All
      // Properties" with no home property leaves nothing to attribute it to,
      // so say that plainly instead of sending an empty value to the database.
      const branchId = ctx.branch_id;
      if (!branchId) {
        throw new Error(
          "Select a single property before raising a purchase request — a request must belong to one property.",
        );
      }

      const { data: seq } = await guardedRpc(supabase, "next_document_number", {
        _doc_type: "purchase-request",
      });

      // One atomic canonical call: header and line are written together, so a
      // failed line can never leave an orphan request. The function itself
      // refuses to raise a second replenishment request for the same item at
      // the same property while an earlier one is still open, which makes a
      // double-click or retry return the first request instead of duplicating.
      const { data, error } = await guardedRpc(supabase, "neo_purchase_request_from_reorder", {
        _stock_item: itemId,
        _branch: branchId,
        _quantity: quantity,
        _unit: String(input.item["base_unit"] ?? "unit"),
        _title: `Replenishment — ${String(input.item["name"] ?? "stock item")}`,
        _justification:
          input.justification ??
          `On hand ${Number(input.item["on_hand"] ?? 0)} against a minimum of ${Number(input.item["min_level"] ?? 0)}.`,
        _estimated_unit_price: Number(input.item["average_cost"] ?? 0) || 0,
        ...(seq ? { _request_number: String(seq) } : {}),
      });
      if (error) throw error;
      const result = (data ?? {}) as Row;
      if (result["duplicate"]) {
        throw new Error(
          "A draft purchase request already exists for this item — open Procurement to review or submit it.",
        );
      }
      return String(result["request_id"] ?? "");
    },
    onSuccess: () => {
      toast.success("Draft purchase request raised — Procurement reviews before anything is ordered");
      void qc.invalidateQueries({ queryKey: ["procurement", "requests"] });
      void qc.invalidateQueries({ queryKey: ["inventory", "reorder"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}



export function useMenuProfitability() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["inventory", "profitability", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "inventory_menu_profitability");
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useStockCategories() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["inventory", "categories", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_categories")
        .select(sel("id, name, kind, code, active, sort_order"))
        .order("sort_order")
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useStockLocations() {
  const { organizationId } = useCtx();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["inventory", "locations", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase.from("stock_locations").select(sel("id, name, code, location_type, is_main, active, branch_id")),
        "stock_locations",
      )
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useStockItems() {
  const { organizationId } = useCtx();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["inventory", "items", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase.from("stock_items").select(
          sel(
            "id, name, sku, base_unit, purchase_unit, purchase_to_base, min_level, reorder_point, par_level, max_level, reorder_quantity, average_cost, last_cost, track_expiry, active, category_id, container_type, container_volume_ml, tracking_method, may_open_for_pours, default_pour_ml, stock_categories(name), stock_levels(quantity_on_hand, location_id)",
          ),
        ),

        "stock_items",
      )
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useStockMovements(limit = 60) {
  const { organizationId } = useCtx();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["inventory", "movements", organizationId, filterKey, limit],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase.from("stock_movements").select(sel("id, movement_type, quantity, unit, value, reason, reference_type, reference_id, created_at, stock_items(name), stock_locations!stock_movements_location_id_fkey(name)")),
        "stock_movements",
      )
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      const movements = (data ?? []) as unknown as Row[];
      const requisitionIds = movements
        .filter((row) => String(row["reference_type"] ?? "").replace(/_/g, "-") === "internal-requisition")
        .map((row) => String(row["reference_id"] ?? ""))
        .filter(Boolean);
      if (requisitionIds.length === 0) return movements;
      const { data: requisitions, error: requisitionError } = await supabase
        .from("internal_requisitions")
        .select("id, request_number, departments(name)")
        .in("id", requisitionIds);
      if (requisitionError) throw requisitionError;
      const byId = new Map(
        ((requisitions ?? []) as unknown as Row[]).map((row) => [String(row["id"]), row]),
      );
      return movements.map((row) => ({
        ...row,
        source_requisition: byId.get(String(row["reference_id"] ?? "")) ?? null,
      }));
    },
  });
}

export function useExpiringBatches() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["inventory", "batches", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_batches")
        .select(sel("id, batch_number, expiry_date, quantity, unit_cost, stock_items(name, base_unit), stock_locations(name)"))
        .gt("quantity", 0)
        .not("expiry_date", "is", null)
        .order("expiry_date")
        .limit(40);
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useSuppliers() {
  const { organizationId } = useCtx();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["procurement", "suppliers", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase
          .from("suppliers")
          .select(sel("id, name, contact_person, phone, email, categories, credit_terms_days, outstanding_balance, rating, on_time_deliveries, late_deliveries, active, branch_id")),
        "suppliers",
      ).order("name");
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function usePurchaseRequests() {
  const { organizationId } = useCtx();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["procurement", "requests", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase
          .from("purchase_requests")
          // The purchase orders already raised from a request travel with it, so
          // the screen can never offer to raise a second order for the same
          // requisition.
          .select(
            sel(
              "id, request_number, title, status, priority, needed_by, estimated_total, created_at, branch_id, justification, source, source_reference, branches(name), departments(name), purchase_orders(id, order_number, status), purchase_request_lines(id, description, quantity, unit, estimated_unit_price, stock_item_id, stock_items(name, sku))",
            ),
          ),
        "purchase_requests",
      ).order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function usePurchaseOrders() {
  const { organizationId } = useCtx();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["procurement", "orders", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase
          .from("purchase_orders")
          .select(sel("id, order_number, status, expected_date, total_amount, currency, created_at, branch_id, branches(name), suppliers(name)")),
        "purchase_orders",
      ).order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useGoodsReceipts() {
  const { organizationId } = useCtx();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["procurement", "receipts", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase
          .from("goods_receipts")
          .select(sel("id, grn_number, status, received_at, total_value, is_partial, branch_id, branches(name), suppliers(name), stock_locations(name)")),
        "goods_receipts",
      ).order("received_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useStockTransfers() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["inventory", "transfers", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_transfers")
        .select(sel("id, transfer_number, status, reason, created_at, from_location:stock_locations!stock_transfers_from_location_id_fkey(name), to_location:stock_locations!stock_transfers_to_location_id_fkey(name)"))
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useStockAdjustments() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["inventory", "adjustments", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_adjustments")
        .select(sel("id, adjustment_number, reason, status, total_value, created_at, stock_locations(name)"))
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useStockTakes() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["inventory", "stock-takes", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_takes")
        .select(sel("id, reference, count_type, status, scheduled_for, variance_value, created_at, stock_locations(name)"))
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

/* ----------------------------- mutations ---------------------------- */

function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: string[]) => {
    for (const key of keys) void qc.invalidateQueries({ queryKey: [key] });
  };
}

export function useSaveRecord(table: string, invalidate: string[], label = "Saved") {
  const invalidateAll = useInvalidate();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (record: Record<string, unknown>) => {
      const payload = { organization_id: ctx.organization_id, ...record };
      const { error } = await supabase.from(table as never).upsert(payload as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(label);
      invalidateAll(...invalidate);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Reorder rules already recorded for the active property.
 *
 * Each property keeps its own reorder point and par level; the catalogue
 * figure on the stock item stays the fallback for a property that has not set
 * its own.
 */
export function useBranchThresholds() {
  const { organizationId } = useCtx();
  // Reorder rules follow the header selection exactly: on "All Properties"
  // there is no property override, so the catalogue default is used.
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["inventory", "branch-thresholds", organizationId, branchId],
    enabled: Boolean(organizationId && branchId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_branch_thresholds")
        .select("stock_item_id, reorder_point, par_level")
        .eq("branch_id", branchId as string);
      if (error) throw error;
      const byItem = new Map<string, { reorder: number | null; par: number | null }>();
      for (const row of (data ?? []) as unknown as Row[]) {
        byItem.set(String(row["stock_item_id"]), {
          reorder: row["reorder_point"] === null ? null : Number(row["reorder_point"]),
          par: row["par_level"] === null ? null : Number(row["par_level"]),
        });
      }
      return byItem;
    },
  });
}

/**
 * Reorder point and par level for one stock item.
 *
 * With a single property selected the figures are stored against that
 * property, so Nairobi and Mombasa can hold quite different levels for the
 * same item. On "All Properties" the organisation-wide catalogue figure is
 * written instead, as the fallback every property inherits.
 */
export function useSaveStockThresholds() {
  const invalidateAll = useInvalidate();
  const ctx = useCtx();
  // Reorder rules follow the header selection exactly: on "All Properties"
  // there is no property override, so the catalogue default is used.
  const { branchId } = useActivePropertyFilter();
  return useMutation({
    mutationFn: async (input: { id: string; reorderPoint: number; parLevel: number }) => {
      if (input.reorderPoint < 0 || input.parLevel < 0) throw new Error("Levels cannot be negative");
      if (input.parLevel > 0 && input.parLevel < input.reorderPoint) {
        throw new Error("The par level has to be at least the reorder point");
      }
      if (branchId) {
        const { error } = await supabase.from("stock_branch_thresholds").upsert(
          {
            organization_id: ctx.organization_id,
            branch_id: branchId,
            stock_item_id: input.id,
            reorder_point: input.reorderPoint,
            par_level: input.parLevel,
            updated_by: ctx.userId,
          } as never,
          { onConflict: "branch_id,stock_item_id" },
        );
        if (error) throw error;
        return;
      }
      const { error } = await supabase
        .from("stock_items")
        .update({ reorder_point: input.reorderPoint, par_level: input.parLevel } as never)
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(branchId ? "Reorder levels saved for this property" : "Reorder levels saved");
      invalidateAll("inventory", "procurement");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Load many reorder points and par levels at once.
 *
 * Used by the bulk loader on the reorder rules tab, so a property's real
 * figures can be pasted in from a spreadsheet rather than typed row by row.
 * With a property selected the figures are stored against that property; on
 * "All Properties" the organisation-wide catalogue figure is written instead.
 */
export function useSaveStockThresholdsBulk() {
  const invalidateAll = useInvalidate();
  const ctx = useCtx();
  // Reorder rules follow the header selection exactly: on "All Properties"
  // there is no property override, so the catalogue default is used.
  const { branchId } = useActivePropertyFilter();
  return useMutation({
    mutationFn: async (rows: Array<{ id: string; reorderPoint: number; parLevel: number }>) => {
      if (rows.length === 0) throw new Error("Nothing to load");
      for (const row of rows) {
        if (row.reorderPoint < 0 || row.parLevel < 0) throw new Error("Levels cannot be negative");
        if (row.parLevel > 0 && row.parLevel < row.reorderPoint) {
          throw new Error("Every par level has to be at least its reorder point");
        }
      }
      if (branchId) {
        const { error } = await supabase.from("stock_branch_thresholds").upsert(
          rows.map((row) => ({
            organization_id: ctx.organization_id,
            branch_id: branchId,
            stock_item_id: row.id,
            reorder_point: row.reorderPoint,
            par_level: row.parLevel,
            updated_by: ctx.userId,
          })) as never,
          { onConflict: "branch_id,stock_item_id" },
        );
        if (error) throw error;
        return rows.length;
      }
      for (const row of rows) {
        const { error } = await supabase
          .from("stock_items")
          .update({ reorder_point: row.reorderPoint, par_level: row.parLevel } as never)
          .eq("id", row.id);
        if (error) throw error;
      }
      return rows.length;
    },
    onSuccess: (count) => {
      toast.success(
        branchId
          ? `${count} reorder rules saved for this property`
          : `${count} reorder rules saved`,
      );
      invalidateAll("inventory", "procurement");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


/**
 * Weekly stores report: item group → category → stock item, with each
 * property's own on-hand balance, reorder alerts and purchase requests
 * already in flight. Passing no property returns every property, so the page
 * can total them side by side.
 */
export function useWeeklyStockReport(branchOverride?: string | null) {
  const { organizationId } = useCtx();
  const { branchId } = useActivePropertyFilter();
  const branch = branchOverride === undefined ? branchId : branchOverride;
  return useQuery({
    queryKey: ["inventory", "weekly-report", organizationId, branch],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_inventory_weekly_report", {
        _branch: branch ?? null,
      });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

export function useDeleteRecord(table: string, invalidate: string[]) {
  const invalidateAll = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from(table as never).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Removed");
      invalidateAll(...invalidate);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Post a manual stock movement (opening balance, direct receipt, issue, waste, correction). */
export function useApplyMovement() {
  const invalidateAll = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      item: string;
      location: string;
      quantity: number;
      unit: string;
      movementType: string;
      unitCost?: number | null;
      reason?: string | null;
      referenceType?: string | null;
      batchNumber?: string | null;
      expiry?: string | null;
      idempotencyKey?: string | null;
    }) => {
      const args: Record<string, unknown> = {
        _item: input.item,
        _location: input.location,
        _quantity: input.quantity,
        _unit: input.unit,
        _movement_type: input.movementType,
      };
      if (input.unitCost != null) args["_unit_cost"] = input.unitCost;
      if (input.reason) args["_reason"] = input.reason;
      if (input.referenceType) args["_reference_type"] = input.referenceType;
      if (input.batchNumber) args["_batch_number"] = input.batchNumber;
      if (input.expiry) args["_expiry"] = input.expiry;
      if (input.idempotencyKey) args["_idempotency_key"] = input.idempotencyKey;
      const { error } = await guardedRpc(supabase, "inventory_apply_movement", args as never);
      if (error) throw error;
    },

    onSuccess: () => {
      toast.success("Stock movement posted.");
      invalidateAll("inventory");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePostReceipt() {
  const invalidateAll = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await guardedRpc(supabase, "inventory_post_receipt", { _receipt: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Delivery posted to stock.");
      invalidateAll("inventory", "procurement");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePostTransfer() {
  const invalidateAll = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await guardedRpc(supabase, "inventory_post_transfer", { _transfer: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Transfer completed.");
      invalidateAll("inventory");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePostAdjustment() {
  const invalidateAll = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await guardedRpc(supabase, "inventory_post_adjustment", { _adjustment: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Adjustment approved and posted.");
      invalidateAll("inventory");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCloseStockTake() {
  const invalidateAll = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await guardedRpc(supabase, "inventory_post_stock_take", { _take: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Stock take closed and variances posted.");
      invalidateAll("inventory");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* --------------------- live stock board (per property) --------------------- */

export type LiveStockItem = {
  stock_item_id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  on_hand: number;
  minimum_stock: number;
  reorder_point: number;
  value: number;
  last_movement_at: string | null;
};

export type LiveStockStore = {
  location_id: string;
  location_name: string;
  location_type: string | null;
  branch_id: string | null;
  lines: number;
  value: number;
  below_minimum: number;
  below_reorder: number;
  out_of_stock: number;
  last_movement_at: string | null;
  items: LiveStockItem[];
};

export type LiveStockBoard = {
  ok: boolean;
  reason?: string;
  generated_at?: string;
  stores: LiveStockStore[];
  totals: {
    lines: number;
    value: number;
    below_minimum: number;
    below_reorder: number;
    out_of_stock: number;
  };
};

/** Every store's current balance for the selected property, straight from the ledger-backed levels. */
export function useLiveStockBoard() {
  const { organizationId, branch_id } = useCtx();
  return useQuery({
    queryKey: ["inventory", "live-board", organizationId, branch_id],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_stock_live_board", { _branch: branch_id });
      if (error) throw error;
      const board = (data ?? {}) as Partial<LiveStockBoard>;
      return {
        ok: board.ok !== false,
        reason: board.reason,
        generated_at: board.generated_at,
        stores: (board.stores ?? []) as LiveStockStore[],
        totals: board.totals ?? {
          lines: 0,
          value: 0,
          below_minimum: 0,
          below_reorder: 0,
          out_of_stock: 0,
        },
      } as LiveStockBoard;
    },
  });
}

/**
 * Rebuilds each store balance from the movement ledger — every receipt, issue,
 * sale consumption, transfer, waste line and reversal. Lines with no recorded
 * movements are reported, never silently zeroed.
 */
export function useRecalculateStockLevels() {
  const invalidateAll = useInvalidate();
  const { branch_id } = useCtx();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_stock_recalculate_levels", { _branch: branch_id });
      if (error) throw error;
      const result = (data ?? {}) as {
        ok?: boolean;
        reason?: string;
        detail?: string;
        checked?: number;
        corrected?: number;
        without_ledger?: number;
      };
      if (result.ok === false) {
        throw new Error(
          result.detail ??
            (result.reason === "not_permitted"
              ? "You do not have permission to recalculate stock."
              : "Stock could not be recalculated."),
        );
      }
      return result;
    },
    onSuccess: (result) => {
      const corrected = Number(result.corrected ?? 0);
      const noBaseline = Number(result.without_ledger ?? 0);
      const tail = noBaseline > 0 ? ` ${noBaseline} lines have no recorded opening balance and were left untouched.` : "";
      toast.success(
        (corrected > 0
          ? `Recalculated ${result.checked ?? 0} lines — ${corrected} corrected from the ledger.`
          : `Recalculated ${result.checked ?? 0} lines — every balance already matched the ledger.`) + tail,
      );
      invalidateAll("inventory");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
