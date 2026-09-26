/**
 * Customer laundry.
 *
 * This is the guest-facing door into the hotel's existing laundry operation —
 * the same orders, price list, department queue, inspection and completion the
 * staff already use. Prices and totals are always decided in the database from
 * the hotel's configured price list; the browser only sends item and quantity.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { guardPreview } from "@/lib/preview-mode";

type Row = Record<string, unknown>;
const rpc = supabase as unknown as {
  rpc: (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export type LaundryPriceItem = {
  id: string;
  name: string;
  service_type: string;
  normal_price: number;
  express_price: number;
  turnaround_hours: number;
  tax_rate: number;
};

export type LaundryOffering = {
  enabled: boolean;
  resident?: boolean;
  public?: boolean;
  collection?: boolean;
  delivery?: boolean;
  items: LaundryPriceItem[];
};

export type HandoverMode = "drop_off" | "collection" | "delivery";

export const handoverLabels: Record<HandoverMode, string> = {
  drop_off: "I will drop it off",
  collection: "Collect from me",
  delivery: "Deliver back to me",
};

export const laundryStatusLabels: Record<string, string> = {
  requested: "Requested",
  "awaiting-collection": "Awaiting collection",
  collected: "Collected",
  received: "Received",
  washing: "Washing",
  drying: "Drying",
  ironing: "Ironing",
  "quality-check": "Quality check",
  packaged: "Packed",
  "ready-for-delivery": "Ready",
  delivered: "Delivered",
  completed: "Completed",
  "on-hold": "On hold",
  disputed: "Being checked",
  cancelled: "Cancelled",
};

export const laundryRefusals: Record<string, string> = {
  not_signed_in: "Please sign in first.",
  no_items: "Add at least one item.",
  invalid_handover: "Choose how the laundry will be handed over.",
  laundry_not_offered: "This hotel has not switched on its laundry service yet.",
  no_customer_record: "We could not find your customer profile for this hotel yet.",
  stay_not_yours: "That booking is not on your account. Verify it first under My Stay.",
  resident_laundry_off: "In-room laundry is not offered at this hotel.",
  public_laundry_off: "Laundry for non-residents is not offered at this hotel.",
  collection_off: "Collection is not offered at this hotel.",
  delivery_off: "Laundry delivery is not offered at this hotel.",
};

export function useLaundryOffering(organizationId: string, branchId?: string | null) {
  return useQuery({
    queryKey: ["guest-laundry-offering", organizationId, branchId ?? "none"],
    enabled: Boolean(branchId),
    queryFn: async (): Promise<LaundryOffering> => {
      const { data, error } = await guardedRpc(rpc, "neo_guest_laundry_pricelist", {
        _org: organizationId,
        _branch: branchId,
      });
      if (error) throw new Error(error.message);
      return (data as unknown as LaundryOffering) ?? { enabled: false, items: [] };
    },
  });
}

export function useMyLaundry(organizationId: string, enabled = true) {
  return useQuery({
    queryKey: ["guest-laundry-mine", organizationId],
    enabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(rpc, "neo_guest_my_laundry", { _org: organizationId });
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

export type PlaceLaundryResult =
  | {
      ok: true;
      order_id: string;
      laundry_number: string;
      total: number;
      payment_intent: string;
      resident: boolean;
    }
  | { ok: false; reason: string };

export function usePlaceLaundryOrder(organizationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      branchId: string;
      items: { price_item_id: string; quantity: number }[];
      express?: boolean;
      handover: HandoverMode;
      reservationId?: string | null;
      instructions?: string;
      channel?: string;
    }): Promise<PlaceLaundryResult> => {
      guardPreview();
      const { data, error } = await guardedRpc(rpc, "neo_guest_place_laundry_order", {
        _org: organizationId,
        _branch: input.branchId,
        _items: input.items,
        _express: input.express ?? false,
        _handover: input.handover,
        _reservation: input.reservationId ?? null,
        _instructions: input.instructions ?? null,
        _channel: input.channel ?? "NEO_APP",
      });
      if (error) throw new Error(error.message);
      return data as unknown as PlaceLaundryResult;
    },
    onSuccess: (result) => {
      if (result.ok) void client.invalidateQueries({ queryKey: ["guest-laundry-mine", organizationId] });
    },
  });
}
