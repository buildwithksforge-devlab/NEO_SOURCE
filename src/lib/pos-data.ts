import { stableIdempotencyKey, stableIdempotencyUuid } from "@/lib/transaction-scope";
import { useScopedRealtime } from "@/lib/realtime-scope";
import { guardedRpc } from "@/lib/rpc-guard";
import { isHalt, settlementOutcome } from "@/lib/command-outcome";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useBranchOptions } from "@/lib/branches";
import { useActivePropertyFilter, useWriteBranchId } from "@/lib/branch-filter";
import { useDataScope } from "@/lib/data-scope";
import {
  DEFAULT_POS_SETTINGS,
  ORDER_TRANSITIONS,
  allowedTransitions,
  generateOrderNumber,
  lineTotal,
  titleCase,
  type PosSettings,
} from "@/lib/pos";
import { withGuardCapture } from "@/lib/guard-violations";

/* ------------------------------------------------------------------ *
 * Reference data
 * ------------------------------------------------------------------ */

export function useStations() {
  const { organizationId } = useAuth();
  const { branchId, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["pos", "stations", organizationId, branchId ?? "all", filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase
        .from("operational_stations")
        .select("id, name, code, station_type, department_id, branch_id, color, active")
        .eq("active", true)
        .order("sort_order")
        .order("name");
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** POS property picker — projects the shared organisation-scoped list. */
export function useBranches() {
  return useBranchOptions();
}


/* ------------------------------------------------------------------ *
 * Floor: areas, tables, reservations
 * ------------------------------------------------------------------ */

/**
 * Floor areas the signed-in member of staff may actually work.
 *
 * The outlet scope is decided by the database (`public.neo_floor_areas`), from
 * the department the person belongs to: bar staff get bar areas, restaurant
 * staff get restaurant, coffee and room-service areas, and whole-house roles
 * get everything. The screen never widens that.
 */
export function useRestaurantAreas() {
  const { branchId, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "areas", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_floor_areas", branchId ? { _branch: branchId } : {});
      if (error) throw error;
      return (data ?? []) as unknown as { id: string; name: string; outlet: string }[];
    },
  });
}

/** Tables, limited to the floor areas the operator's outlet scope permits. */
export function useRestaurantTables() {
  const { applyTo, filterKey, branchId } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "tables", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const [{ data, error }, areas] = await Promise.all([
        applyTo(supabase.from("restaurant_tables").select("*, restaurant_areas(name)"), "restaurant_tables").order("code"),
        guardedRpc(supabase, "neo_floor_areas", branchId ? { _branch: branchId } : {}),
      ]);
      if (error) throw error;
      if (areas.error) throw areas.error;
      const permitted = new Set(
        ((areas.data ?? []) as unknown as Record<string, unknown>[]).map((a) => String(a["id"])),
      );
      return (data ?? []).filter((t) => {
        const area = (t as Record<string, unknown>)["area_id"];
        return !area || permitted.has(String(area));
      });
    },
  });
}

export function useTableReservations(fromIso?: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "table-reservations", organizationId, fromIso ?? "all", filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(supabase.from("table_reservations").select("*, restaurant_tables(code, name), customers(full_name, phone)"), "table_reservations")
        .order("reserved_from");
      if (fromIso) q = q.gte("reserved_from", fromIso);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Menu
 * ------------------------------------------------------------------ */

export function useMenus() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "menus", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("menus").select("*"), "menus").order("display_order").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useMenuCategories() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "menu-categories", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("menu_categories")
        .select("*, menus(name)")
        .order("display_order")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useMenuItems() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "menu-items", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("menu_items").select("*, menu_categories(name, menu_id), operational_stations(name, code)"), "menu_items")
        .order("display_order")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useModifierGroups() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "modifier-groups", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("modifier_groups")
        .select("*, modifier_options(*)")
        .order("display_order")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * The modifier groups configured for one menu item, with their options.
 * Used by the waiter's add-item dialog so choices and their extra charges are
 * priced from the catalogue rather than typed in.
 */
export function useItemModifierGroups(menuItemId: string | undefined) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "item-modifier-groups", organizationId, menuItemId],
    enabled: Boolean(organizationId && menuItemId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("menu_item_modifier_groups")
        .select(
          "display_order, modifier_groups(id, name, required, multi_select, min_select, max_select, modifier_options(id, name, extra_charge, active))",
        )
        .eq("menu_item_id", menuItemId as string)
        .order("display_order");
      if (error) throw error;
      return (data ?? [])
        .map((r) => (r as { modifier_groups: ModifierGroupWithOptions | null }).modifier_groups)
        .filter((g): g is ModifierGroupWithOptions => Boolean(g));
    },
  });
}

export type ModifierGroupWithOptions = {
  id: string;
  name: string;
  required: boolean | null;
  multi_select: boolean | null;
  min_select: number | null;
  max_select: number | null;
  modifier_options: { id: string; name: string; extra_charge: number | null; active: boolean | null }[];
};

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */

const OPEN_STATUSES = [
  "draft",
  "held",
  "confirmed",
  "sent",
  "accepted",
  "in-preparation",
  "partially-ready",
  "ready",
  "partially-served",
  "served",
  "awaiting-payment",
];

export function usePosOrders(scope: "open" | "all" | "closed" = "open") {
  // Self scope means a waiter sees only their own bills: `applyScope` narrows by
  // property, then department for a supervisor, then to own/assigned rows.
  const { applyScope, scopeKey } = useDataScope();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "orders", organizationId, scopeKey, scope],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyScope(supabase.from("pos_orders").select("*, restaurant_tables(code, name), customers(full_name), profiles!pos_orders_waiter_id_fkey(full_name)"), "pos_orders")
        .order("created_at", { ascending: false })
        .limit(200);
      if (scope === "open") q = q.in("status", OPEN_STATUSES);
      if (scope === "closed") q = q.in("status", ["paid", "charged-to-room", "credit", "closed", "voided", "cancelled"]);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function usePosOrder(orderId: string | undefined) {
  const { organizationId } = useAuth();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["pos", "order", organizationId, filterKey, orderId],
    enabled: Boolean(organizationId && orderId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase
          .from("pos_orders")
          .select(
            // The table's area carries the outlet, so a tab opened on a bar
            // table sells the bar's menus even when its order type is generic.
            "*, restaurant_tables(code, name, restaurant_areas(outlet, name)), customers(id, full_name, phone), pos_order_items(*, pos_order_item_modifiers(*), operational_stations(name, code)), pos_payments(*)",
          ),
        "pos_orders",
      )
        .eq("id", orderId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useStationTickets(stationId: string | "all") {
  const { organizationId } = useAuth();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["pos", "station-tickets", organizationId, filterKey, stationId],
    enabled: Boolean(organizationId),
    refetchInterval: 30_000,
    queryFn: async () => {
      let q = applyTo(
        supabase.from("station_tickets").select(
          "*, operational_stations(name, code), pos_orders(order_number, order_type, guest_count, guest_name, dietary_notes, allergy_alert, restaurant_tables(code)), station_ticket_items(order_item_id, pos_order_items(*, pos_order_item_modifiers(option_name, group_name)))",
        ),
        "station_tickets",
      )
        .not("status", "in", "(cancelled,served)")
        .order("created_at");
      if (stationId !== "all") q = q.eq("station_id", stationId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Live invalidation for POS surfaces — one channel, torn down on unmount. */
export function usePosRealtime() {
  const qc = useQueryClient();
  useScopedRealtime("pos-live", [
    {
      table: "pos_orders",
      onChange: () => {
        void qc.invalidateQueries({ queryKey: ["pos", "orders"] });
        void qc.invalidateQueries({ queryKey: ["pos", "order"] });
      },
    },
    {
      table: "pos_order_items",
      onChange: () => {
        void qc.invalidateQueries({ queryKey: ["pos", "order"] });
        void qc.invalidateQueries({ queryKey: ["pos", "station-tickets"] });
      },
    },
    { table: "station_tickets", onChange: () => void qc.invalidateQueries({ queryKey: ["pos", "station-tickets"] }) },
    { table: "restaurant_tables", onChange: () => void qc.invalidateQueries({ queryKey: ["pos", "tables"] }) },
  ]);
}

/* ------------------------------------------------------------------ *
 * Shifts, payments, requests
 * ------------------------------------------------------------------ */

export function usePosShifts() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "shifts", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("pos_shifts").select("*, profiles!pos_shifts_cashier_id_fkey(full_name), operational_stations(name)"), "pos_shifts")
        .order("opened_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useMyOpenShift() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId, user } = useAuth();
  return useQuery({
    queryKey: ["pos", "my-shift", organizationId, user?.id, filterKey],
    enabled: Boolean(organizationId && user?.id),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("pos_shifts").select("*"), "pos_shifts")
        .eq("cashier_id", user!.id)
        .eq("status", "open")
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useVoidRequests() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "void-requests", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("pos_void_requests").select("*, pos_orders(order_number), pos_order_items(item_name)"), "pos_void_requests")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useRefundRequests() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "refund-requests", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("pos_refund_requests").select("*, pos_orders(order_number), pos_payments(method, amount)"), "pos_refund_requests")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function usePrinterProfiles() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "printers", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("printer_profiles").select("*, operational_stations(name)"), "printer_profiles")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Checked-in stays only — the sole valid target for a room charge. */
export function useCheckedInStays() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "checked-in-stays", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("stays").select("id, branch_id, status, expected_departure, checked_in_at, rooms(room_number), customers(id, full_name)"), "stays")
        .eq("status", "in-house");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useOpenFolioForStay(stayId: string | undefined) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "stay-folio", organizationId, stayId],
    enabled: Boolean(organizationId && stayId),
    queryFn: async () => {
      // Folio rows are restricted to front-office/finance readers. Service staff
      // resolve the open room account through a guarded lookup instead.
      const { data, error } = await guardedRpc(supabase, "pos_open_folio_for_stay", { _stay: stayId! });
      if (error) throw error;
      const rows = (data ?? []) as Array<{
        id: string;
        folio_number: string;
        status: string;
        balance: number;
        currency: string;
      }>;
      return rows[0] ?? null;
    },
  });
}

export function usePosSettings() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "settings", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<{ id: string | null; settings: PosSettings }> => {
      const { data, error } = await applyTo(supabase.from("pos_settings").select("*"), "pos_settings").limit(1).maybeSingle();
      if (error) throw error;
      return {
        id: data?.id ?? null,
        settings: { ...DEFAULT_POS_SETTINGS, ...((data?.settings as Partial<PosSettings>) ?? {}) },
      };
    },
  });
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

function useOrgContext() {
  const { organizationId, user } = useAuth();
  // New records follow the property the operator is actually working in.
  const branchId = useWriteBranchId();
  return {
    organization_id: organizationId!,
    branch_id: branchId,
    userId: user?.id ?? null,
  };
}

/**
 * A new bill must carry a resolved workspace, property and operator. Without
 * them the insert reaches the database with a missing organisation and is
 * refused by the row-level policy, which the waiter sees as a raw database
 * error. Fail fast with an actionable message instead.
 */
function assertWriteContext(ctx: {
  organization_id: string | null;
  branch_id: string | null;
  userId: string | null;
}): void {
  if (!ctx.userId) {
    throw new Error("Your session has not finished loading. Please refresh and try again.");
  }
  if (!ctx.organization_id) {
    throw new Error(
      "Your workspace is still resolving. Refresh the page, then reopen the order.",
    );
  }
  if (!ctx.branch_id) {
    throw new Error("Select the property you are working in before opening a bill.");
  }
}

export function useCreateOrder() {
  const qc = useQueryClient();
  const ctx = useOrgContext();
  return useMutation({
    mutationFn: async (input: {
      order_type: string;
      order_source?: string;
      table_id?: string | null;
      customer_id?: string | null;
      guest_count?: number;
      guest_name?: string | null;
      contact_phone?: string | null;
      shift_id?: string | null;
      notes?: string | null;
    }) => {
      assertWriteContext(ctx);
      const { data, error } = await supabase
        .from("pos_orders")
        .insert({
          organization_id: ctx.organization_id,
          branch_id: ctx.branch_id,
          order_number: generateOrderNumber(),
          order_type: input.order_type,
          order_source: input.order_source ?? "waiter-pos",
          table_id: input.table_id ?? null,
          customer_id: input.customer_id ?? null,
          guest_count: input.guest_count ?? 1,
          guest_name: input.guest_name ?? null,
          contact_phone: input.contact_phone ?? null,
          shift_id: input.shift_id ?? null,
          notes: input.notes ?? null,
          waiter_id: ctx.userId,
          created_by: ctx.userId,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pos", "orders"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

type MenuItemLike = {
  id: string;
  name: string;
  description: string | null;
  base_price: number | string;
  tax_rate: number | string;
  station_id: string | null;
};

export function useAddOrderItem() {
  const qc = useQueryClient();
  const ctx = useOrgContext();
  return useMutation({
    mutationFn: async (input: {
      orderId: string;
      item: MenuItemLike;
      quantity: number;
      course: string;
      instructions?: string;
      allergyNote?: string;
      modifiers?: { group_id: string; option_id: string; group_name: string; option_name: string; extra_charge: number }[];
    }) => {
      const modTotal = (input.modifiers ?? []).reduce((s, m) => s + Number(m.extra_charge ?? 0), 0);
      const unit = Number(input.item.base_price ?? 0);
      const taxRate = Number(input.item.tax_rate ?? 0);
      const total = lineTotal(input.quantity, unit, modTotal);
      const taxAmount = Number(((total * taxRate) / (100 + taxRate)).toFixed(2));

      const { data, error } = await supabase
        .from("pos_order_items")
        .insert({
          organization_id: ctx.organization_id,
          order_id: input.orderId,
          menu_item_id: input.item.id,
          station_id: input.item.station_id,
          item_name: input.item.name,
          item_description: input.item.description,
          course: input.course,
          quantity: input.quantity,
          unit_price: unit,
          modifier_total: modTotal,
          tax_rate: taxRate,
          tax_amount: taxAmount,
          line_total: total,
          special_instructions: input.instructions ?? null,
          allergy_note: input.allergyNote ?? null,
          created_by: ctx.userId,
        })
        .select("id")
        .single();
      if (error) throw error;

      if (input.modifiers?.length) {
        const { error: modErr } = await supabase.from("pos_order_item_modifiers").insert(
          input.modifiers.map((m) => ({
            organization_id: ctx.organization_id,
            order_item_id: data.id,
            group_id: m.group_id,
            option_id: m.option_id,
            group_name: m.group_name,
            option_name: m.option_name,
            extra_charge: m.extra_charge,
          })),
        );
        if (modErr) throw modErr;
      }
      await recalcOrderTotals(input.orderId);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pos", "order"] });
      void qc.invalidateQueries({ queryKey: ["pos", "orders"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Draft items can be deleted; anything sent must go through the void workflow. */
export function useRemoveDraftItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, orderId }: { itemId: string; orderId: string }) => {
      const { error } = await supabase.from("pos_order_items").delete().eq("id", itemId).eq("status", "draft");
      if (error) throw error;
      await recalcOrderTotals(orderId);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pos", "order"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Configured discount policies for the property that owns the bill.
 *
 * These are trading rules the property configures, never values invented at
 * the till: an empty list means no discount may be applied here yet.
 */
export function usePosDiscountPolicies() {
  const { organizationId } = useAuth();
  const { branchId, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["pos", "discount-policies", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase
        .from("pos_discounts")
        .select("id, name, scope, discount_type, value, max_value, requires_approval, order_types, active")
        .eq("organization_id", organizationId!)
        .eq("active", true)
        .order("name");
      if (branchId) q = q.or(`branch_id.eq.${branchId},branch_id.is.null`);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Apply or clear a configured discount on a bill.
 *
 * The boundary (policy validity, order type, maximum value and whether the
 * policy needs approval) is enforced by `neo_pos_apply_discount` in the
 * database, so the till cannot exceed a configured cap. Totals stay owned by
 * the authoritative order-totals trigger.
 */
export function useApplyPosDiscount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      orderId,
      discountId,
      reason,
    }: {
      orderId: string;
      discountId: string | null;
      reason?: string;
    }) => {
      const { data, error } = await guardedRpc(supabase, "neo_pos_apply_discount", {
        _order: orderId,
        _discount: discountId,
        _reason: reason ?? null,
      } as never);
      if (error) throw error;
      return (data ?? {}) as {
        discount_total?: number;
        capped?: boolean;
        effective_percent?: number;
        approval_level?: string;
      };
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["pos", "order"] });
      toast.success(
        r.discount_total
          ? `Discount of ${r.discount_total} applied${r.effective_percent ? ` (${Number(r.effective_percent).toFixed(2)}%)` : ""}${r.capped ? " — capped at the configured maximum" : ""}.`
          : "Discount removed from this bill.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export async function recalcOrderTotals(orderId: string) {
  // Totals (subtotal, tax, configured service charge, grand total) are owned by
  // the authoritative database trigger on pos_orders — never recomputed here,
  // so there is only ever one arithmetic of record. This write simply asks the
  // database to re-derive them from the current live lines.
  const { data: order } = await supabase
    .from("pos_orders")
    .select("id, discount_total")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return;
  await supabase
    .from("pos_orders")
    .update({ discount_total: Number(order.discount_total ?? 0) })
    .eq("id", orderId);
}

/**
 * Send the order to the kitchen through the single authoritative contract.
 *
 * `neo_pos_send_to_kitchen` owns routing, ticket creation and item status: it
 * takes a per-order lock, resolves each item's station from the canonical
 * resolver, raises one ticket per station and course, and links each source
 * item exactly once (the database refuses a second live link). Retries,
 * refreshes and double taps therefore reuse the existing ticket instead of
 * duplicating kitchen work. An item with no configured production station now
 * rejects the whole send: nothing is ticketed and the order stays unsent until
 * routing is configured, so the kitchen never receives work it cannot see.
 */
export function useSendOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (orderId: string) => {
      const { data, error } = await guardedRpc(supabase, "neo_pos_send_to_kitchen", {
        _order: orderId,
        // Derived from the order, not from a fresh UUID: a double-tap, a
        // refresh mid-request or a reconnect all describe the same send, so
        // the attempt they record is the same attempt rather than a new one.
        _attempt: stableIdempotencyUuid("pos", "send_to_kitchen", [orderId]),
      } as never);
      if (error) throw error;
      const r = (data ?? {}) as {
        tickets_created?: number;
        items_created?: number;
        items_reused?: number;
        unassigned_station?: number;
      };
      return {
        tickets: Number(r.tickets_created ?? 0),
        items: Number(r.items_created ?? 0),
        reused: Number(r.items_reused ?? 0),
        unassigned: Number(r.unassigned_station ?? 0),
      };
    },
    onSuccess: (r) => {
      if (r.items === 0 && r.reused > 0) {
        toast.info("Already with the kitchen — no duplicate tickets raised.");
      } else {
        toast.success(`${r.items} item(s) sent to ${r.tickets} station ticket(s).`);
      }
      if (r.unassigned > 0) {
        toast.warning(`${r.unassigned} item(s) have no production station and need assigning.`);
      }
    },
    onError: (e: Error) => toast.error(explainPosSendError(e.message)),
    // Stay pending until the refreshed order, queue and reconciliation views
    // have arrived, so the Send button cannot be tapped again against a list
    // that still shows the old state.
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["pos"] }),
        qc.invalidateQueries({ queryKey: ["kitchen"] }),
        qc.invalidateQueries({ queryKey: ["reconciliation", "pos-kds"] }),
      ]),
  });
}

/**
 * A send rejected because routing is unresolved is a configuration statement,
 * not a transient failure: the order is untouched and stays sendable once a
 * production station is configured for the item.
 */
export function explainPosSendError(message: string) {
  const m = /routing_unresolved:\s*(\d+)/.exec(message);
  if (m) {
    return `Not sent — ${m[1]} item(s) have no production station for this property. Assign a station to the menu item, then send again.`;
  }
  const s = /store_unmapped:\s*(.+?)\s+has no consumption store/.exec(message);
  if (s) {
    return `Not sent — ${s[1]} has no store to take stock from at this property. Map the station to its store in Inventory settings, then send again.`;
  }
  return explainPosStatusError(message);
}


/**
 * Turn a raw state-machine rejection into an explicit statement of the graph
 * the server actually enforces, so a UI/RPC mismatch can never fail silently.
 */
export function explainPosStatusError(message: string) {
  const m = /Invalid order status transition (\S+) -> (\S+)/.exec(message);
  if (!m) return message;
  const [, from, to] = m;
  const allowed = allowedTransitions(from);
  return `Cannot move this order from “${titleCase(from)}” to “${titleCase(to)}”. Allowed from “${titleCase(
    from,
  )}”: ${allowed.length ? allowed.map(titleCase).join(", ") : "none"}.`;
}

/**
 * Lightweight read-only diagnostics: the order's live status and the exact
 * transition rulebook `pos_enforce_order_status()` evaluates server-side.
 */
export function usePosOrderDiagnostics(orderId: string | undefined, enabled = false) {
  return useQuery({
    queryKey: ["pos", "diagnostics", orderId],
    enabled: Boolean(orderId) && enabled,
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_pos_order_diagnostics", {
        _order: orderId,
      } as never);
      if (error) throw error;
      const d = (data ?? {}) as {
        found?: boolean;
        status?: string;
        payment_status?: string;
        grand_total?: number | string;
        sent_at?: string | null;
        allowed_next?: string[];
        rules?: Record<string, string[]>;
      };
      return {
        found: Boolean(d.found),
        status: d.status ?? null,
        paymentStatus: d.payment_status ?? null,
        grandTotal: Number(d.grand_total ?? 0),
        sentAt: d.sent_at ?? null,
        allowedNext: d.allowed_next ?? [],
        rules: d.rules ?? ORDER_TRANSITIONS,
      };
    },
  });
}

export function useUpdateItemStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, status }: { itemId: string; status: string }) => {
      const { error } = await supabase.from("pos_order_items").update({ status }).eq("id", itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateTicketStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ticketId,
      status,
      itemIds,
      delayReason,
    }: {
      ticketId: string;
      status: string;
      itemIds: string[];
      delayReason?: string;
    }) => {
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = { status };
      if (status === "accepted") patch["accepted_at"] = now;
      if (status === "preparing") patch["started_at"] = now;
      if (status === "ready") patch["ready_at"] = now;
      if (status === "delayed") patch["delay_reason"] = delayReason ?? "Not stated";
      const { error } = await supabase.from("station_tickets").update(patch as never).eq("id", ticketId);
      if (error) throw error;

      const itemStatus =
        status === "accepted" ? "accepted" : status === "preparing" ? "preparing" : status === "ready" ? "ready" : null;
      if (itemStatus && itemIds.length) {
        const { error: itemErr } = await supabase
          .from("pos_order_items")
          .update({ status: itemStatus })
          .in("id", itemIds);
        if (itemErr) throw itemErr;
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateOrderStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, status }: { orderId: string; status: string }) => {
      await withGuardCapture(
        {
          guard: "neo_pos_lifecycle_guard",
          table: "pos_orders",
          payload: { status },
          recordId: orderId,
        },
        async () => {
          const { error } = await supabase.from("pos_orders").update({ status }).eq("id", orderId);
          if (error) throw error;
        },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Settlement outcome returned by the server-owned contract. The browser never
 * decides whether a bill is paid or may close — it only reports what the
 * database resolved.
 */
export type SettlementResult = {
  payment_id: string;
  status: string;
  duplicate: boolean;
  grand_total: number;
  paid_total: number;
  pending_total: number;
  balance: number;
  payment_status: string;
  open_items: number;
  closed: boolean;
};

function settlementToast(r: SettlementResult) {
  if (r.duplicate) {
    toast.info("That payment was already recorded — nothing was charged twice.");
    return;
  }
  if (r.status !== "confirmed") {
    toast.success("Payment recorded as pending verification.");
    return;
  }
  if (r.closed) toast.success("Bill fully settled and closed.");
  else if (r.balance > 0) toast.success(`Payment recorded. Balance outstanding ${r.balance.toFixed(2)}.`);
  else if (r.open_items > 0)
    toast.success(`Bill fully paid. ${r.open_items} item(s) are still open, so it stays on the floor until they are served or voided.`);
  else toast.success("Payment recorded.");
}

/**
 * Records a settlement attempt through `pos_record_payment_attempt`. Validation
 * (balance ceiling, order state, idempotency) and closure all happen inside one
 * server transaction.
 */
export function useRecordPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      orderId: string;
      amount: number;
      method: string;
      tendered?: number;
      externalReference?: string;
      shiftId?: string | null;
      manualConfirm?: boolean;
      note?: string;
      idempotencyKey?: string;
      /** Which of the hotel's accounts received the money. */
      destinationAccountId?: string | null;
    }) => {
      const { data, error } = await guardedRpc(supabase, "pos_record_payment_attempt", {
        _order_id: input.orderId,
        _amount: input.amount,
        _method: input.method,
        _manual_confirm: Boolean(input.manualConfirm),
        ...(input.destinationAccountId ? { _account: input.destinationAccountId } : {}),
        ...(input.tendered === undefined ? {} : { _tendered: input.tendered }),
        ...(input.externalReference ? { _reference: input.externalReference } : {}),
        ...(input.shiftId ? { _shift_id: input.shiftId } : {}),
        ...(input.idempotencyKey ? { _idempotency_key: input.idempotencyKey } : {}),
        ...(input.note ? { _note: input.note } : {}),
      });
      if (error) throw error;
      return data as unknown as SettlementResult;
    },
    onSuccess: (r) => {
      settlementToast(r);
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Confirms a pending external payment manually, with a mandatory note. */
export function useConfirmManualPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { paymentId: string; note: string }) => {
      const { data, error } = await guardedRpc(supabase, "pos_confirm_manual_payment", {
        _payment_id: input.paymentId,
        _note: input.note,
      });
      if (error) throw error;
      return data as unknown as SettlementResult;
    },
    onSuccess: (r) => {
      settlementToast(r);
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Re-derives paid total, payment status and closure for one bill. */
export function useReconcileSettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (orderId: string) => {
      const { data, error } = await guardedRpc(supabase, "pos_reconcile_order_settlement", { _order_id: orderId });
      if (error) throw error;
      return data as unknown as SettlementResult;
    },
    onSuccess: (r) => {
      const result = settlementOutcome(r as unknown as Parameters<typeof settlementOutcome>[0]);
      if (isHalt(result.status)) toast.error(result.message);
      else toast.success(result.message);
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


export function usePostRoomCharge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, folioId }: { orderId: string; folioId: string }) => {
      const { data, error } = await guardedRpc(supabase, "pos_post_room_charge", {
        _order_id: orderId,
        _folio_id: folioId,
        _idempotency_key: `pos-room-charge:${orderId}`,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Charge posted to the guest folio.");
      void qc.invalidateQueries({ queryKey: ["pos"] });
      void qc.invalidateQueries({ queryKey: ["pms"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRequestVoid() {
  const qc = useQueryClient();
  const ctx = useOrgContext();
  return useMutation({
    mutationFn: async (input: {
      orderId: string;
      orderItemId?: string | null;
      kind: string;
      amount: number;
      reason: string;
      preparationStatus?: string | null;
    }) => {
      const { error } = await supabase.from("pos_void_requests").insert({
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        order_id: input.orderId,
        order_item_id: input.orderItemId ?? null,
        request_kind: input.kind,
        amount: input.amount,
        reason: input.reason,
        preparation_status: input.preparationStatus ?? null,
        requested_by: ctx.userId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Void request sent for approval.");
      void qc.invalidateQueries({ queryKey: ["pos", "void-requests"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDecideVoid() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const qc = useQueryClient();
  const ctx = useOrgContext();
  return useMutation({
    mutationFn: async ({ id, approve, note }: { id: string; approve: boolean; note?: string }) => {
      const { data: req, error: reqErr } = await applyTo(supabase.from("pos_void_requests").select("*"), "pos_void_requests")
        .eq("id", id)
        .single();
      if (reqErr) throw reqErr;
      if (req.requested_by === ctx.userId) throw new Error("You cannot approve your own request.");
      if (req.status !== "pending") throw new Error("This request has already been decided.");

      const { error } = await supabase
        .from("pos_void_requests")
        .update({
          status: approve ? "applied" : "rejected",
          decided_by: ctx.userId,
          decided_at: new Date().toISOString(),
          decision_note: note ?? null,
        })
        .eq("id", id)
        .eq("status", "pending");
      if (error) throw error;

      if (approve && req.order_item_id) {
        await supabase.from("pos_order_items").update({ status: "cancel-pending" }).eq("id", req.order_item_id);
        await supabase.from("pos_order_items").update({ status: "voided" }).eq("id", req.order_item_id);
        await recalcOrderTotals(req.order_id);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pos", filterKey] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRequestRefund() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const qc = useQueryClient();
  const ctx = useOrgContext();
  return useMutation({
    mutationFn: async (input: { orderId: string; paymentId: string; amount: number; reason: string; method?: string }) => {
      const { data: payment, error: payErr } = await applyTo(supabase.from("pos_payments").select("amount, status"), "pos_payments")
        .eq("id", input.paymentId)
        .single();
      if (payErr) throw payErr;
      if (payment.status !== "confirmed") throw new Error("Only confirmed payments can be refunded.");
      if (input.amount > Number(payment.amount)) throw new Error("Refund cannot exceed the original payment.");

      const { error } = await supabase.from("pos_refund_requests").insert({
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        order_id: input.orderId,
        payment_id: input.paymentId,
        amount: input.amount,
        reason: input.reason,
        method: input.method ?? null,
        requested_by: ctx.userId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Refund request sent for approval.");
      void qc.invalidateQueries({ queryKey: ["pos", "refund-requests", filterKey] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDecideRefund() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const qc = useQueryClient();
  const ctx = useOrgContext();
  return useMutation({
    mutationFn: async ({ id, approve, note }: { id: string; approve: boolean; note?: string }) => {
      const { data: req, error: reqErr } = await applyTo(supabase.from("pos_refund_requests").select("*"), "pos_refund_requests")
        .eq("id", id)
        .single();
      if (reqErr) throw reqErr;
      if (req.requested_by === ctx.userId) throw new Error("You cannot approve your own request.");
      // The RPC decides the request, marks the payment refunded and posts the
      // reversing entry to Finance in one transaction — no dead-end approvals.
      const { error } = await (supabase as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
      }).rpc("neo_pos_refund_decide", {
        _request: id,
        _approve: approve,
        _note: note ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useOpenShift() {
  const qc = useQueryClient();
  const ctx = useOrgContext();
  return useMutation({
    mutationFn: async ({ openingFloat, stationId }: { openingFloat: number; stationId?: string | null }) => {
      const { error } = await supabase.from("pos_shifts").insert({
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        station_id: stationId ?? null,
        cashier_id: ctx.userId!,
        opening_float: openingFloat,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Shift opened.");
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCloseShift() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ shiftId, countedCash, reason }: { shiftId: string; countedCash: number; reason?: string }) => {
      const { data: shift, error: shiftErr } = await applyTo(supabase.from("pos_shifts").select("id, opening_float"), "pos_shifts")
        .eq("id", shiftId)
        .single();
      if (shiftErr) throw shiftErr;

      const { data: payments } = await applyTo(supabase.from("pos_payments").select("amount"), "pos_payments")
        .eq("shift_id", shiftId)
        .eq("method", "cash")
        .eq("status", "confirmed");
      const cashSales = (payments ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0);
      const expected = Number(shift.opening_float ?? 0) + cashSales;
      const variance = Number((countedCash - expected).toFixed(2));
      if (Math.abs(variance) > 0.005 && !reason?.trim()) {
        throw new Error("A cash variance must be explained before the shift can close.");
      }

      const { error } = await supabase
        .from("pos_shifts")
        .update({
          expected_cash: expected,
          counted_cash: countedCash,
          variance,
          variance_reason: reason ?? null,
          closed_at: new Date().toISOString(),
          status: Math.abs(variance) > 0.005 ? "variance-review" : "closed",
        })
        .eq("id", shiftId);
      if (error) throw error;
      return { variance };
    },
    onSuccess: (r) => {
      toast.success(r.variance === 0 ? "Shift closed and balanced." : `Shift closed with a variance of ${r.variance}.`);
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Configuration mutations
 * ------------------------------------------------------------------ */

export function useSaveRecord(table: "restaurant_areas" | "restaurant_tables" | "menus" | "menu_categories" | "menu_items" | "modifier_groups" | "modifier_options" | "printer_profiles" | "table_reservations") {
  const qc = useQueryClient();
  const ctx = useOrgContext();
  return useMutation({
    mutationFn: async ({ id, values }: { id?: string | null; values: Record<string, unknown> }) => {
      if (id) {
        const { error } = await supabase.from(table).update(values as never).eq("id", id);
        if (error) throw error;
        return;
      }
      const payload: Record<string, unknown> = { ...values, organization_id: ctx.organization_id };
      if (
        ["restaurant_areas", "restaurant_tables", "menus", "menu_items", "printer_profiles", "table_reservations"].includes(
          table,
        )
      ) {
        payload["branch_id"] = values["branch_id"] ?? ctx.branch_id;
      }
      if (["restaurant_areas", "restaurant_tables", "menus", "menu_items", "table_reservations"].includes(table)) {
        payload["created_by"] = ctx.userId;
      }
      const { error } = await supabase.from(table).insert(payload as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Saved.");
      void qc.invalidateQueries({ queryKey: ["pos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useSavePosSettings() {
  const qc = useQueryClient();
  const ctx = useOrgContext();
  return useMutation({
    mutationFn: async ({ id, settings }: { id: string | null; settings: PosSettings }) => {
      if (id) {
        const { error } = await supabase.from("pos_settings").update({ settings }).eq("id", id);
        if (error) throw error;
        return;
      }
      const { error } = await supabase.from("pos_settings").insert({
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        settings,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("POS settings saved.");
      void qc.invalidateQueries({ queryKey: ["pos", "settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Canonical menu catalogue
 *
 * `neo_menu_catalogue` is the only reader of what an outlet actually sells:
 * active published items, scoped to the caller's properties, each carrying the
 * station that will actually receive the ticket and where that routing came
 * from (item rule, category rule, item default or category default).
 * ------------------------------------------------------------------ */

/**
 * How completely an item is connected to the recipe/inventory engine.
 *
 * `direct-stock` is a complete configuration, not a gap: the item is sold
 * straight from a stock item (a bottled drink, say) so every sale deducts that
 * item rather than a list of ingredients. `no-stock` is also complete: the item
 * deliberately moves no stock at all (a service charge, a corkage fee).
 */
export type MenuRecipeStatus =
  | "not-linked"
  | "incomplete"
  | "linked"
  | "direct-stock"
  | "no-stock";

/** The four ways a menu item can consume stock. */
export type ConsumptionMode = "none" | "direct_stock" | "recipe" | "batch";

export const CONSUMPTION_MODES: { value: ConsumptionMode; label: string; hint: string }[] = [
  { value: "none", label: "No stock consumption", hint: "Sold without touching inventory." },
  { value: "direct_stock", label: "Direct stock", hint: "One sale takes a finished product off the shelf." },
  { value: "recipe", label: "Recipe", hint: "A sale consumes the listed ingredients." },
  { value: "batch", label: "Produced / batch item", hint: "A sale takes from a produced batch." },
];

export function consumptionModeLabel(mode: string | null | undefined): string {
  return CONSUMPTION_MODES.find((m) => m.value === mode)?.label ?? "No stock consumption";
}

/** True when consumption is fully configured — including a deliberate "none". */
export function menuConsumptionReady(status: MenuRecipeStatus): boolean {
  return status === "linked" || status === "direct-stock" || status === "no-stock";
}

export type MenuCatalogueRow = {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  currency: string | null;
  image_url: string | null;
  prep_minutes: number | null;
  recipe_status: MenuRecipeStatus;
  consumption_mode?: ConsumptionMode | null;
  /** Set for direct-stock and batch items: the stock item each sale deducts. */
  direct_stock_item_id?: string | null;
  direct_stock_item_name?: string | null;
  direct_stock_unit?: string | null;
  direct_stock_quantity?: number | null;
  issuing_location_id?: string | null;
  issuing_location_name?: string | null;
  consumption_channels?: string[] | null;

  category_id: string | null;
  category_name: string | null;
  menu_id: string | null;
  menu_name: string | null;
  menu_outlet: string | null;
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
  station_source: string;
  station_missing: boolean;
  assigned_station_id: string | null;
  imported: boolean;
  import_batch_id: string | null;
  import_file_name: string | null;
  import_batch_status: string | null;
  published_at: string | null;
  updated_at: string;
};

/**
 * Reads the canonical catalogue. Ordering terminals leave `includeDrafts` off
 * so they only ever see published, sellable rows; Menu Management turns it on
 * to count published and draft records from the same scoped source.
 */
export function useMenuCatalogue(includeDrafts = false, branchOverride?: string | null) {
  const { organizationId } = useAuth();
  const { branchId: activeBranch, filterKey } = useActivePropertyFilter();
  // A terminal always sells the catalogue of the property the order belongs to,
  // never the property currently selected in the shell: an order opened while
  // "All properties" is active must not expose another property's prices.
  const branchId = branchOverride ?? activeBranch;
  return useQuery({
    queryKey: ["pos", "menu-catalogue", organizationId, branchId ?? "all", includeDrafts, filterKey],
    enabled: Boolean(organizationId) && (branchOverride === undefined || Boolean(branchId)),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_menu_catalogue", {
        ...(branchId ? { _branch: branchId } : {}),
        _include_drafts: includeDrafts,
      } as never);
      if (error) throw error;
      return (data ?? []) as unknown as MenuCatalogueRow[];
    },
  });
}


export function useAssignMenuStation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, stationId }: { itemId: string; stationId: string | null }) => {
      const { error } = await guardedRpc(supabase, "neo_menu_assign_station", {
        _item_id: itemId,
        _station_id: stationId as unknown as string,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Production station updated.");
      void qc.invalidateQueries({ queryKey: ["pos"] });
      void qc.invalidateQueries({ queryKey: ["kitchen"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Menu catalogue management — canonical property → department → station
 *
 * Every dropdown below is served by the same database functions that refuse an
 * invalid combination on write, so the screen can never offer a choice the
 * backend would reject.
 * ------------------------------------------------------------------ */

export type MenuScopedDepartment = {
  id: string;
  name: string;
  catalogue_key: string | null;
  branch_id: string | null;
  branch_specific: boolean;
};

export type MenuScopedStation = {
  id: string;
  name: string;
  code: string | null;
  station_type: string | null;
  department_id: string | null;
  branch_id: string | null;
};

/**
 * The fields the catalogue reader does not carry (description, prep minutes)
 * for a single item, so editing an item never blanks what it is not showing.
 */
export function useMenuItemDetail(itemId: string | null | undefined) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "menu-item-detail", organizationId, itemId ?? "none", filterKey],
    enabled: Boolean(organizationId && itemId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("menu_items").select("id, description, prep_minutes, image_url, sku, currency"), "menu_items")
        .eq("id", itemId as string)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as {
        id: string;
        description: string | null;
        prep_minutes: number | null;
        image_url: string | null;
        sku: string | null;
        currency: string | null;
      } | null;
    },
  });
}

/** Departments valid for the selected property, deduplicated by the database. */

export function useMenuDepartments(branchId: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "menu-departments", organizationId, branchId ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_menu_departments", {
        ...(branchId ? { _branch: branchId } : {}),
      } as never);
      if (error) throw error;
      return (data ?? []) as unknown as MenuScopedDepartment[];
    },
  });
}

/** Stations valid for the selected property and department. */
export function useMenuStations(branchId: string | null, departmentId: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "menu-stations", organizationId, branchId ?? "all", departmentId ?? "any"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_menu_stations", {
        ...(branchId ? { _branch: branchId } : {}),
        ...(departmentId ? { _department: departmentId } : {}),
      } as never);
      if (error) throw error;
      return (data ?? []) as unknown as MenuScopedStation[];
    },
  });
}

export type MenuSavePayload = {
  id?: string | null;
  name: string;
  description?: string | null;
  branchId: string | null;
  serviceType: string;
  outlet?: string | null;
  status: string;
  validFrom?: string | null;
  validTo?: string | null;
  validTimeFrom?: string | null;
  validTimeTo?: string | null;
};

function useMenuInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["pos"] });
    void qc.invalidateQueries({ queryKey: ["kitchen"] });
  };
}

/** Create or edit a menu. The database owns every validity rule. */
export function useSaveMenu() {
  const invalidate = useMenuInvalidate();
  return useMutation({
    mutationFn: async (payload: MenuSavePayload) => {
      const { data, error } = await guardedRpc(supabase, "neo_menu_save", {
        _id: payload.id ?? null,
        _name: payload.name,
        _description: payload.description ?? null,
        _branch: payload.branchId,
        _service_type: payload.serviceType,
        _outlet: payload.outlet ?? null,
        _status: payload.status,
        _valid_from: payload.validFrom || null,
        _valid_to: payload.validTo || null,
        _valid_time_from: payload.validTimeFrom || null,
        _valid_time_to: payload.validTimeTo || null,
      } as never);
      if (error) throw error;
      return data as unknown as { ok: boolean; menu_id: string };
    },
    onSuccess: () => {
      toast.success("Menu saved.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Deactivate, retire or reactivate a menu — never a destructive act. */
export function useSetMenuStatus() {
  const invalidate = useMenuInvalidate();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await guardedRpc(supabase, "neo_menu_set_status", { _id: id, _status: status } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Menu status updated.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Permanent removal. Blocked by the database whenever anything references the menu. */
export function useDeleteMenu() {
  const invalidate = useMenuInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await guardedRpc(supabase, "neo_menu_delete", { _id: id } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Menu removed.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export type MenuItemSavePayload = {
  id?: string | null;
  name: string;
  description?: string | null;
  branchId: string | null;
  categoryId: string | null;
  departmentId: string | null;
  stationId: string | null;
  basePrice: number;
  taxRate: number;
  prepMinutes: number;
  availability: string;
  /** Stored object path in the `menu-images` bucket, or an absolute URL. */
  imageUrl?: string | null;
  /** Stable trade key used by imports to update instead of duplicate. */
  sku?: string | null;
  currency?: string | null;
};

/** Create or edit a menu item under the enforced property → department → station chain. */
export function useSaveMenuItem() {
  const invalidate = useMenuInvalidate();
  return useMutation({
    mutationFn: async (payload: MenuItemSavePayload) => {
      const { data, error } = await guardedRpc(supabase, "neo_menu_save_item", {
        _id: payload.id ?? null,
        _name: payload.name,
        _description: payload.description ?? null,
        _branch: payload.branchId,
        _category: payload.categoryId,
        _department: payload.departmentId,
        _station: payload.stationId,
        _base_price: payload.basePrice,
        _tax_rate: payload.taxRate,
        _prep_minutes: payload.prepMinutes,
        _availability: payload.availability,
        _image_url: payload.imageUrl ?? null,
        _sku: payload.sku ?? null,
        _currency: payload.currency ?? null,
      } as never);
      if (error) throw error;
      return data as unknown as { ok: boolean; item_id: string };
    },
    onSuccess: () => {
      toast.success("Menu item saved.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
