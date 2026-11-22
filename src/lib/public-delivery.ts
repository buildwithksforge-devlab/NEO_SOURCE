/**
 * Public Delivery App data layer.
 *
 * Scoped to one resolved workspace (organisation + optional branch) and used by
 * anonymous / customer sessions only. Every money or status decision is taken
 * by the existing SECURITY DEFINER functions — the browser only reads.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardPreview } from "@/lib/preview-mode";
import { requireGuestOrderResult } from "@/lib/guest-order-result";
import { resolvePublicWorkspace } from "@/lib/public-apps.functions";

type Row = Record<string, unknown>;

const sb = supabase as unknown as {
  from: (t: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export type Quote = {
  currency?: string;
  subtotal: number;
  tax_total: number;
  tax_breakdown?: { label: string; amount: number }[] | null;
  discount_total: number;
  /** The property's configured service charge — the same figure the till applies. */
  service_charge: number;
  delivery_fee: number;
  tip_amount: number;
  grand_total: number;
  eta_minutes: number;
  issues: string[];
  can_checkout: boolean;
  lines: Row[];
};

function keys(organizationId: string) {
  return ["public-delivery", organizationId] as const;
}

export function usePublishedDeliveryForGuest(organizationId: string, branchId: string | null, slug: string, enabled = true) {
  return useQuery({
    queryKey: [...keys(organizationId), "published-workspace", branchId, slug],
    enabled: enabled && Boolean(branchId),
    staleTime: 60_000,
    queryFn: async () => {
      const workspace = await resolvePublicWorkspace({ data: { appKey: "delivery", slug } });
      return workspace?.organization_id === organizationId && workspace.branch_id === branchId ? workspace : null;
    },
  });
}

/** Branches of this organisation that participate in delivery/pickup. */
export function usePublicBranches(organizationId: string, branchId: string | null) {
  return useQuery({
    queryKey: [...keys(organizationId), "branches", branchId ?? "all"],
    queryFn: async () => {
      let q = sb
        .from("branches")
        .select("id, name, code, is_main, phone, address")
        .eq("organization_id", organizationId)
        .eq("active", true)
        .order("name");
      if (branchId) q = q.eq("id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

export function usePublicDeliverySettings(organizationId: string, branchId: string | null) {
  return useQuery({
    queryKey: [...keys(organizationId), "settings", branchId ?? "org"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("delivery_settings")
        .select("*")
        .eq("organization_id", organizationId);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Row[];
      return (
        rows.find((r) => r["branch_id"] === branchId) ??
        rows.find((r) => r["branch_id"] === null) ??
        null
      );
    },
  });
}

export function usePublicZones(organizationId: string, branchId: string | null) {
  return useQuery({
    queryKey: [...keys(organizationId), "zones", branchId ?? "all"],
    queryFn: async () => {
      let q = sb
        .from("delivery_zones")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("active", true)
        .order("name");
      if (branchId) q = q.or(`branch_id.eq.${branchId},branch_id.is.null`);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

/**
 * Live POS menu for public surfaces.
 *
 * Reads the single canonical contract `neo_public_menu` — the same routine the
 * guest ordering screen uses — so the Guest and Delivery apps can never drift
 * apart on publish status, availability windows or fulfilment eligibility.
 * Never exposes recipe or cost data.
 */
export function usePublicMenu(
  organizationId: string,
  branchId: string | null,
  fulfilment: "delivery" | "pickup" | "room-service" = "delivery",
  enabled = true,
) {
  return useQuery({
    queryKey: [...keys(organizationId), "menu", branchId ?? "all", fulfilment],
    enabled,
    refetchInterval: 15_000,
    queryFn: async () => {
      // Preserve the embedded-category shape the public screens already read.
      return (await loadPublicMenu(organizationId, branchId, fulfilment)).map((row) => ({
        ...row,
        menu_categories: row["category_name"] ? { name: row["category_name"] } : null,
      })) as Row[];
    },
  });
}

export async function loadPublicMenu(organizationId: string, branchId: string | null, fulfilment: string) {
  const args = { _org: organizationId, _branch: branchId, _fulfilment: fulfilment };
  const stock = await guardedRpc<Row[]>(sb, "neo_public_menu_with_stock", args);
  // Support the existing published menu during an app-first database rollout.
  const result = stock.error && ["PGRST202", "42883"].includes(stock.error.code ?? "")
    ? await guardedRpc<Row[]>(sb, "neo_public_menu", args)
    : stock;
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}


/** The signed-in person's customer record inside THIS organisation. */
export function useMyPublicCustomer(organizationId: string, userId?: string | null) {
  return useQuery({
    queryKey: [...keys(organizationId), "me", userId ?? "anon"],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("customers")
        .select("id, organization_id, primary_branch_id, full_name, phone, email, customer_number")
        .eq("auth_user_id", userId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as Row | null) ?? null;
    },
  });
}

export function useMyPublicCart(organizationId: string, customerId?: string | null) {
  return useQuery({
    queryKey: [...keys(organizationId), "cart", customerId ?? "none"],
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("carts")
        .select(
          "*, cart_items(*, menu_items(name, base_price, image_url, availability, available_delivery), cart_item_modifiers(*))",
        )
        .eq("organization_id", organizationId)
        .eq("customer_id", customerId)
        .eq("status", "active")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as Row | null) ?? null;
    },
  });
}

export function usePublicAddToCart(organizationId: string, customerId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      branchId: string | null;
      menuItemId: string;
      quantity?: number;
      specialInstructions?: string;
      allergyNote?: string;
      optionIds?: string[];
      fulfilment?: "delivery" | "pickup";
    }) => {
      guardPreview();
      if (!customerId) throw new Error("Sign in to start an order");
      const { error } = await guardedRpc(sb, "neo_guest_cart_add_item", {
        _org: organizationId,
        _fulfilment: input.fulfilment ?? "delivery",
        _menu_item: input.menuItemId,
        _quantity: input.quantity ?? 1,
        _special_instructions: input.specialInstructions ?? null,
        _allergy_note: input.allergyNote ?? null,
        _branch: input.branchId,
        _options: input.optionIds ?? [],
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Added to your order");
      void qc.invalidateQueries({ queryKey: ["public-delivery"] });
      void qc.invalidateQueries({ queryKey: ["guest-cart"] });
      void qc.invalidateQueries({ queryKey: ["guest-quote"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePublicUpdateCartItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; quantity: number }) => {
      guardPreview();
      const { error } = await guardedRpc(sb, "neo_guest_cart_set_quantity", {
        _line: input.id,
        _quantity: input.quantity,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["public-delivery"] });
      void qc.invalidateQueries({ queryKey: ["guest-cart"] });
      void qc.invalidateQueries({ queryKey: ["guest-quote"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePublicUpdateCart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Row & { id: string }) => {
      guardPreview();
      const { id, ...patch } = input;
      const { error } = await guardedRpc(sb, "neo_guest_cart_update", {
        _cart: id,
        _patch: patch,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["public-delivery"] });
      void qc.invalidateQueries({ queryKey: ["guest-cart"] });
      void qc.invalidateQueries({ queryKey: ["guest-quote"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Server-authoritative pricing. Browser totals are never trusted. */
export function usePublicQuote(cartId?: string | null) {
  return useQuery({
    queryKey: ["public-delivery", "quote", cartId ?? "none"],
    enabled: Boolean(cartId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(sb, "delivery_quote_cart", { _cart: cartId });
      if (error) throw new Error(error.message);
      return data as Quote;
    },
  });
}

export function usePublicPlaceOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { cartId: string; paymentMethod: string }) => {
      guardPreview();
      const { data, error } = await guardedRpc(sb, "delivery_place_order", {
        _cart: input.cartId,
        _payment_method: input.paymentMethod,
      });
      if (error) throw new Error(error.message);
      return requireGuestOrderResult(data);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["public-delivery"] });
      void qc.invalidateQueries({ queryKey: ["guest-cart"] });
      void qc.invalidateQueries({ queryKey: ["guest-quote"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Sends the M-Pesa request for the guest's own order. The order stays awaiting
 * payment until Safaricom confirms it, so nothing here declares success.
 */
export function useDeliveryMpesaCharge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { orderId: string; msisdn: string }) => {
      const { chargeDeliveryWithMpesa } = await import("@/lib/mpesa.functions");
      return await chargeDeliveryWithMpesa({ data: input });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["public-delivery"] }),
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useMyPublicOrders(organizationId: string, customerId?: string | null, branchId?: string | null) {
  return useQuery({
    queryKey: [...keys(organizationId), "orders", customerId ?? "none", branchId ?? "all"],
    enabled: Boolean(customerId),
    queryFn: async () => {
      let query = sb
        .from("delivery_orders")
        .select(
          "id, order_number, order_status, fulfilment_type, payment_status, payment_method, grand_total, currency, created_at, estimated_delivery_at, scheduled_for, branch_id",
        )
        .eq("organization_id", organizationId)
        .eq("customer_id", customerId);
      if (branchId) query = query.eq("branch_id", branchId);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(50);
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

/** Tracking by order reference — RLS still decides what the caller may read. */
export function usePublicOrderByReference(organizationId: string, reference: string, branchId: string | null, userId?: string) {
  return useQuery({
    queryKey: [...keys(organizationId), "track", reference, branchId, userId],
    enabled: Boolean(organizationId && reference && userId),
    refetchInterval: (query) => {
      const order = query.state.data;
      if (!order || ["cancelled", "rejected", "failed", "delivered", "completed"].includes(String(order["order_status"]))) {
        return false;
      }
      return 5_000;
    },
    queryFn: async () => {
      let query = sb
        .from("delivery_orders")
        .select(
          "id, order_number, order_status, kitchen_status, dispatch_status, fulfilment_type, payment_status, payment_method, grand_total, currency, created_at, estimated_delivery_at, contact_name, rider_id, branch_id",
        )
        .eq("organization_id", organizationId)
        .eq("order_number", reference);
      if (branchId) query = query.eq("branch_id", branchId);
      const { data, error } = await query.maybeSingle();
      if (error) throw new Error(error.message);
      return (data as Row | null) ?? null;
    },
  });
}

export function useMyPublicAddresses(organizationId: string, customerId?: string | null) {
  return useQuery({
    queryKey: [...keys(organizationId), "addresses", customerId ?? "none"],
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("customer_addresses")
        .select("*")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

export function useSavePublicAddress(organizationId: string, customerId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: Row) => {
      if (!customerId) throw new Error("Sign in to save an address");
      const { data, error } = await sb
        .from("customer_addresses")
        .insert({ ...values, organization_id: organizationId, customer_id: customerId })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data["id"] as string;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["public-delivery"] }),
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Human label for every status in the delivery / pickup lifecycle. */
export const orderStatusLabels: Record<string, string> = {
  draft: "Order received",
  "pending-payment": "Payment pending",
  "payment-pending": "Payment pending",
  "payment-verification": "Verifying payment",
  placed: "Order received",
  confirmed: "Confirmed",
  accepted: "Accepted",
  "in-preparation": "Preparing",
  ready: "Ready",
  "ready-for-pickup": "Ready for collection",
  "awaiting-rider": "Awaiting rider",
  "rider-assigned": "Rider assigned",
  collected: "Collected",
  "out-for-delivery": "On the way",
  arrived: "Arrived",
  delivered: "Delivered",
  completed: "Completed",
  cancelled: "Cancelled",
  rejected: "Cancelled",
  "delivery-failed": "Delivery failed",
  returned: "Returned to restaurant",
};

export function statusLabel(status: unknown) {
  const key = String(status ?? "");
  return orderStatusLabels[key] ?? (key.replace(/-/g, " ") || "Unknown");
}

export function money(amount: unknown, currency = "KES") {
  const value = Number(amount ?? 0);
  return `${currency} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
