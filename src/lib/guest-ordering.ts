/**
 * NEØ Guest ordering, billing and transport data layer.
 *
 * Ownership is never asserted by the browser: every routine here resolves the
 * signed-in customer server-side from `auth.uid()`, and every plain table read
 * is filtered again by the owner-scoped row-level policies. Nothing in this
 * file can widen what a guest may see.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardPreview } from "@/lib/preview-mode";

type Row = Record<string, unknown>;

const sb = supabase as unknown as {
  from: (t: string) => any;
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export type FulfilmentType = "room-service" | "pickup" | "delivery";

export const fulfilmentLabels: Record<FulfilmentType, string> = {
  "room-service": "Deliver to my room",
  pickup: "Collect at the property",
  delivery: "Deliver to my address",
};


/* ------------------------------------------------------------------ stay */

export type ActiveStay = {
  reservation_id: string;
  confirmation_number: string;
  branch_id: string | null;
  arrival_date: string;
  departure_date: string;
  status: string;
  room_number: string | null;
  folio_id: string | null;
  folio_number: string | null;
  folio_balance: number | null;
  can_charge_to_room: boolean;
};

/** The signed-in guest's in-house stay, if any. */
export function useGuestActiveStay(organizationId: string, enabled = true) {
  return useQuery({
    queryKey: ["guest-stay", organizationId],
    enabled,
    queryFn: async () => {
      const { data, error } = await guardedRpc(sb, "neo_guest_active_stay", { _org: organizationId });
      if (error) throw new Error(error.message);
      return (data as ActiveStay | null) ?? null;
    },
  });
}

/* ----------------------------------------------------------------- folio */

export type GuestFolioLine = {
  id: string;
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  tax_amount: number | null;
  discount_amount: number | null;
  net_amount: number | null;
  posting_date: string | null;
};

export type GuestFolio = {
  id: string;
  folio_number: string | null;
  status: string | null;
  currency: string | null;
  opened_at: string | null;
  closed_at: string | null;
  net_revenue: number | null;
  total_discounts: number | null;
  tax: number | null;
  service_charge: number | null;
  gross_obligation: number | null;
  collected: number | null;
  outstanding: number | null;
  lines: GuestFolioLine[];
};

export type GuestReceipt = {
  id: string;
  receipt_number: string | null;
  amount: number | null;
  currency: string | null;
  method: string | null;
  paid_at: string | null;
  folio_id: string | null;
};

/**
 * The guest's own bill, projected server-side.
 *
 * Ownership is resolved inside the database routine from the signed-in
 * account — the browser never supplies a customer id — and the projection
 * carries only guest-facing fields: no internal notes, source records, staff
 * ids or accounting references.
 */
export function useGuestBill(organizationId: string, enabled = true, awaitingProvider = false) {
  return useQuery({
    queryKey: ["guest-bill", organizationId],
    enabled,
    // A sent STK request is not money. Refresh until the provider callback
    // changes the server projection; reopening the tab also refetches it.
    refetchInterval: awaitingProvider ? 5_000 : false,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error } = await guardedRpc(sb, "neo_guest_folio_projection", { _org: organizationId });
      if (error) throw new Error(error.message);
      const payload = (data ?? {}) as { folios?: GuestFolio[]; payments?: GuestReceipt[] };
      return {
        folios: payload.folios ?? [],
        payments: payload.payments ?? [],
      };
    },
  });
}


/**
 * Whether the property can actually take a card/mobile payment from the guest
 * app. Nothing is faked: with no configured collection contract the screen
 * says so and points the guest at the front desk.
 */
export function useGuestPaymentAvailability(organizationId: string) {
  return useQuery({
    queryKey: ["guest-payment-availability", organizationId],
    queryFn: async () => {
      // The integration table itself is staff-only, so availability is asked
      // of a guarded routine that answers with a boolean and nothing else.
      const { data, error } = await guardedRpc(sb, "neo_guest_payment_availability", {
        _org: organizationId,
      });
      if (error) return { available: false as const, reason: "not-configured" as const };
      const payload = (data ?? {}) as { available?: boolean };
      return {
        available: Boolean(payload.available),
        reason: payload.available ? ("configured" as const) : ("not-configured" as const),
      };
    },
  });
}

/* ---------------------------------------------------------------- menu */

export type PublicMenuItem = {
  id: string;
  name: string;
  description: string | null;
  base_price: number;
  tax_rate: number;
  image_url: string | null;
  prep_minutes: number | null;
  category_id: string | null;
  category_name: string | null;
  availability: string;
  branch_id: string | null;
};

/** Published, currently-available items for one fulfilment type. */
export function useGuestMenu(
  organizationId: string,
  branchId: string | null,
  fulfilment: FulfilmentType,
) {
  return useQuery({
    queryKey: ["guest-menu", organizationId, branchId ?? "all", fulfilment],
    queryFn: async () => {
      const { data, error } = await guardedRpc(sb, "neo_public_menu", {
        _org: organizationId,
        _branch: branchId,
        _fulfilment: fulfilment,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as PublicMenuItem[];
    },
  });
}

/* ------------------------------------------------------------ modifiers */

export type GuestModifierOption = { option_id: string; name: string; extra_charge: number | null };
export type GuestModifierGroup = {
  group_id: string;
  name: string;
  required: boolean | null;
  multi_select: boolean | null;
  min_select: number | null;
  max_select: number | null;
  options: GuestModifierOption[];
};

/**
 * Read-only projection of the property's published item options. Only the
 * option name and the extra charge a guest would pay are exposed — no costs,
 * recipes or internal configuration.
 */
export function useGuestMenuModifiers(organizationId: string, itemIds: string[]) {
  const key = [...itemIds].sort().join(",");
  return useQuery({
    queryKey: ["guest-menu-modifiers", organizationId, key],
    enabled: itemIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(sb, "neo_public_menu_modifiers", {
        _org: organizationId,
        _items: itemIds,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, GuestModifierGroup[]>;
    },
  });
}

/* ----------------------------------------------------------------- cart */


export function useGuestCart(organizationId: string, customerId?: string | null) {
  return useQuery({
    queryKey: ["guest-cart", organizationId, customerId ?? "none"],
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("carts")
        .select("*, cart_items(id, menu_item_id, quantity, special_instructions, allergy_note)")
        .eq("customer_id", customerId)
        .eq("status", "active")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as Row | null) ?? null;
    },
  });
}

export function useGuestCartMutations(
  organizationId: string,
  customerId?: string | null,
  branchId: string | null = null,
) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["guest-cart"] });
    void qc.invalidateQueries({ queryKey: ["guest-quote"] });
  };

  /**
   * Adds a line through the database routine so the basket, its notes and any
   * chosen options are priced from the published catalogue — the browser never
   * states a price, and options that are not published for the item are
   * ignored server-side.
   */
  const addItem = useMutation({
    mutationFn: async (input: {
      fulfilment: FulfilmentType;
      menuItemId: string;
      quantity?: number | undefined;
      specialInstructions?: string | undefined;
      allergyNote?: string | undefined;
      optionIds?: string[] | undefined;
    }) => {
      guardPreview();
      const { error } = await guardedRpc(sb, "neo_guest_cart_add_item", {
        _org: organizationId,
        _fulfilment: input.fulfilment,
        _menu_item: input.menuItemId,
        _quantity: input.quantity ?? 1,
        _special_instructions: input.specialInstructions ?? null,
        _allergy_note: input.allergyNote ?? null,
        _branch: branchId,
        _options: input.optionIds ?? [],
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Added to your order");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setQuantity = useMutation({
    mutationFn: async (input: { id: string; quantity: number }) => {
      guardPreview();
      const { error } = await guardedRpc(sb, "neo_guest_cart_set_quantity", {
        _line: input.id,
        _quantity: input.quantity,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const updateCart = useMutation({
    mutationFn: async (patch: Row & { id: string }) => {
      guardPreview();
      const { id, ...rest } = patch;
      const { error } = await guardedRpc(sb, "neo_guest_cart_update", {
        _cart: id,
        _patch: rest,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  return { addItem, setQuantity, updateCart };
}

export type GuestQuote = {
  subtotal: number;
  tax_total: number;
  discount_total: number;
  /** The property's configured service charge — the same figure the till applies. */
  service_charge: number;
  delivery_fee: number;
  tip_amount: number;
  grand_total: number;
  eta_minutes: number;
  issues: string[];
  can_checkout: boolean;
  fulfilment_type: string;
  lines: Row[];
};

/** Server-authoritative pricing; browser totals are never trusted. */
export function useGuestQuote(cartId?: string | null) {
  return useQuery({
    queryKey: ["guest-quote", cartId ?? "none"],
    enabled: Boolean(cartId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(sb, "delivery_quote_cart", { _cart: cartId });
      if (error) throw new Error(error.message);
      return data as GuestQuote;
    },
  });
}

/** Room service: canonical POS order, kitchen tickets and optional room charge. */
export function usePlaceRoomServiceOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { cartId: string; paymentIntent: "room-charge" | "pay-at-property" }) => {
      guardPreview();
      const { data, error } = await guardedRpc(sb, "neo_guest_place_room_service", {
        _cart: input.cartId,
        _payment_intent: input.paymentIntent,
      });
      if (error) throw new Error(error.message);
      return data as { order_number: string; charged_to_room: boolean };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["guest-cart"] });
      void qc.invalidateQueries({ queryKey: ["public-delivery"] });
      void qc.invalidateQueries({ queryKey: ["guest-folios"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Pickup / outside delivery through the existing canonical placement routine. */
export function usePlaceDeliveryOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { cartId: string; paymentMethod: string }) => {
      guardPreview();
      const { data, error } = await guardedRpc(sb, "delivery_place_order", {
        _cart: input.cartId,
        _payment_method: input.paymentMethod,
      });
      if (error) throw new Error(error.message);
      return data as { order_number: string; pin: string };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["guest-cart"] });
      void qc.invalidateQueries({ queryKey: ["public-delivery"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* -------------------------------------------------------------- tracking */

export type GuestTracking = {
  id: string;
  order_number: string;
  fulfilment_type: string;
  order_status: string;
  kitchen_status: string | null;
  dispatch_status: string | null;
  payment_status: string;
  payment_method: string | null;
  subtotal: number;
  tax_total: number;
  service_charge: number;
  discount_total: number;
  delivery_fee: number;
  grand_total: number;
  currency: string;
  receipt_number: string | null;
  paid_at: string | null;
  created_at: string;
  estimated_delivery_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  /** True only while no station has taken the order on and nothing is paid. */
  can_cancel: boolean;
  courier: { display_name: string; vehicle_type: string | null; availability_status: string } | null;
  items: { name: string; quantity: number; line_total: number; status: string }[];
  timeline: { status: string; kind: string; at: string }[];
};

/** Own order only. The routine refuses a reference belonging to anyone else. */
export function useGuestOrderTracking(organizationId: string, reference?: string) {
  return useQuery({
    queryKey: ["guest-tracking", organizationId, reference ?? "none"],
    enabled: Boolean(reference),
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(sb, "neo_guest_order_tracking", {
        _org: organizationId,
        _reference: reference,
      });
      if (error) throw new Error(error.message);
      return (data as GuestTracking | null) ?? null;
    },
  });
}

/**
 * Guest cancellation. The property's kitchen decides the real boundary: once a
 * station has taken the order on, or money has been taken, only staff can act.
 */
export function useCancelGuestOrder(organizationId: string, reference?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { reason?: string }) => {
      guardPreview();
      const { data, error } = await guardedRpc(sb, "neo_guest_order_cancel", {
        _org: organizationId,
        _reference: reference,
        _reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as { ok?: boolean; reason?: string };
      if (!result.ok) {
        throw new Error(
          result.reason === "already_started"
            ? "This order has already been started or paid for — please contact the property."
            : result.reason === "unknown_order"
              ? "That order is no longer available."
              : "The order could not be cancelled.",
        );
      }
      return result;
    },
    onSuccess: () => {
      toast.success("Order cancelled");
      void qc.invalidateQueries({ queryKey: ["guest-tracking"] });
      void qc.invalidateQueries({ queryKey: ["public-delivery"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------ favourites */

export function useGuestFavourites(organizationId: string, customerId?: string | null) {
  return useQuery({
    queryKey: ["guest-favourites", organizationId, customerId ?? "none"],
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("customer_favourites")
        .select("id, menu_item_id")
        .eq("organization_id", organizationId)
        .eq("customer_id", customerId);
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

export function useToggleFavourite(organizationId: string, customerId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { menuItemId: string; favouriteId?: string | null }) => {
      guardPreview();
      if (!customerId) throw new Error("Sign in to save favourites");
      const { error } = await guardedRpc(sb, "neo_guest_toggle_favourite", {
        _org: organizationId,
        _menu_item: input.menuItemId,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["guest-favourites"] }),
    onError: (e: Error) => toast.error(e.message),
  });
}

/* -------------------------------------------------------------- transport */

export const transportCategories = [
  { value: "airport", label: "Airport transfer" },
  { value: "train", label: "SGR / train station" },
  { value: "bus", label: "Bus station" },
  { value: "town", label: "Property to town" },
  { value: "attraction", label: "Attraction / excursion" },
  { value: "custom", label: "Other transfer" },
] as const;

export const transportStatusLabels: Record<string, string> = {
  requested: "Requested",
  quoted: "Quote offered",
  confirmed: "Confirmed",
  "driver-assigned": "Driver assigned",
  arriving: "Driver arriving",
  "picked-up": "Picked up",
  completed: "Completed",
  cancelled: "Cancelled",
  declined: "Declined",
};

export function useTransportProducts(organizationId: string) {
  return useQuery({
    queryKey: ["transport-products", organizationId],
    queryFn: async () => {
      const { data, error } = await sb
        .from("transport_products")
        .select("id, name, category, description, base_price, currency, max_passengers, branch_id")
        .eq("organization_id", organizationId)
        .eq("active", true)
        .order("display_order");
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

export function useMyTransportRequests(organizationId: string, customerId?: string | null) {
  return useQuery({
    queryKey: ["transport-requests", organizationId, customerId ?? "none"],
    enabled: Boolean(customerId),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from("transport_requests")
        .select(
          "id, request_number, category, status, pickup_at, pickup_point, destination, passengers, luggage_count, travel_reference, notes, quoted_amount, currency, created_at",
        )
        .eq("organization_id", organizationId)
        .eq("customer_id", customerId)
        .order("pickup_at", { ascending: false })
        .limit(30);
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

export function useRequestTransport(organizationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      productId: string | null;
      pickupAt: string;
      pickupPoint: string;
      destination: string;
      passengers: number;
      luggage: number;
      travelReference?: string | null;
      notes?: string | null;
    }) => {
      guardPreview();
      const { data, error } = await guardedRpc(sb, "neo_guest_request_transport", {
        _org: organizationId,
        _product: input.productId,
        _pickup_at: input.pickupAt,
        _pickup_point: input.pickupPoint,
        _destination: input.destination,
        _passengers: input.passengers,
        _luggage: input.luggage,
        _travel_reference: input.travelReference ?? null,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return data as { request_number: string; status: string; quoted_amount: number | null };
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["transport-requests"] }),
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Starts an idempotent customer-owned folio M-Pesa checkout and dispatches the real STK request. */
export function useGuestFolioMpesaCheckout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { organizationId: string; folioId: string; msisdn: string; amount?: number }) => {
      guardPreview();
      const { chargeGuestFolioWithMpesa } = await import("@/lib/mpesa.functions");
      const result = await chargeGuestFolioWithMpesa({ data: input });
      if (!result.ok) throw new Error(result.detail);
      return result;
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["guest-bill"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
}
