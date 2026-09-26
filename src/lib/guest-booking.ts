/**
 * Guest self-service booking.
 *
 * Availability and pricing are resolved by the database against the same
 * canonical room availability the front office uses, so the guest app can
 * never offer a room the property has already committed.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { guardPreview } from "@/lib/preview-mode";

const rpc = supabase as unknown as {
  rpc: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export type RoomOffer = {
  room_type_id: string;
  room_type_name: string;
  description: string | null;
  max_occupancy: number | null;
  amenities: unknown;
  rooms_available: number;
  rate_plan_id: string | null;
  rate_plan_name: string | null;
  nightly_rate: number;
  currency: string;
  tax_rate: number;
  service_charge_rate: number;
  nights: number;
  total_amount: number;
};

export type OfferSearch = {
  organizationId: string;
  branchId: string | null;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
};

export function nightsBetween(arrival: string, departure: string) {
  if (!arrival || !departure) return 0;
  const a = Date.parse(`${arrival}T00:00:00Z`);
  const d = Date.parse(`${departure}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(d) || d <= a) return 0;
  return Math.round((d - a) / 86_400_000);
}

export function useRoomOffers(search: OfferSearch, enabled: boolean) {
  const valid = Boolean(
    search.branchId && nightsBetween(search.arrival, search.departure) > 0,
  );
  return useQuery({
    queryKey: [
      "guest-room-offers",
      search.organizationId,
      search.branchId ?? "none",
      search.arrival,
      search.departure,
      search.adults,
      search.children,
    ],
    enabled: enabled && valid,
    queryFn: async () => {
      const { data, error } = await guardedRpc(rpc, "neo_guest_room_offers", {
        _org: search.organizationId,
        _branch: search.branchId,
        _arrival: search.arrival,
        _departure: search.departure,
        _adults: search.adults,
        _children: search.children,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as RoomOffer[];
    },
  });
}

export function useCreateGuestBooking(organizationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      branchId: string;
      roomTypeId: string;
      arrival: string;
      departure: string;
      adults: number;
      children: number;
      specialRequests?: string;
      intentKey: string;
    }) => {
      guardPreview();
      const { data, error } = await guardedRpc(rpc, "neo_guest_create_booking", {
        _org: organizationId,
        _branch: input.branchId,
        _room_type: input.roomTypeId,
        _arrival: input.arrival,
        _departure: input.departure,
        _adults: input.adults,
        _children: input.children,
        _special_requests: input.specialRequests ?? null,
        _intent_key: input.intentKey,
      });
      if (error) throw new Error(error.message);
      return data as {
        ok: boolean;
        idempotent: boolean;
        id: string;
        confirmation_number: string;
        total_amount: number;
      };
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["guest-reservations", organizationId] });
      void client.invalidateQueries({ queryKey: ["guest-room-offers", organizationId] });
    },
  });
}

/* ------------------------------------------------------- booking deposit */

export type GuestBookingPosition = {
  ok: boolean;
  reason?: string;
  reservation_id?: string;
  confirmation_number?: string;
  status?: string;
  currency?: string;
  total_amount?: number;
  required?: number;
  paid?: number;
  outstanding?: number;
  can_pay_online?: boolean;
};

/** Deposit position for the signed-in guest's own booking only. */
export function useGuestBookingPosition(organizationId: string, reference: string) {
  return useQuery({
    queryKey: ["guest-booking-position", organizationId, reference],
    enabled: Boolean(organizationId && reference),
    queryFn: async () => {
      const { data, error } = await guardedRpc(rpc, "neo_guest_reservation_position", {
        _org: organizationId,
        _reference: reference,
      });
      if (error) throw new Error(error.message);
      return (data ?? { ok: false }) as GuestBookingPosition;
    },
  });
}

/** Starts a mobile-money collection towards the outstanding deposit. */
export function usePayGuestDeposit(organizationId: string, reference: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { msisdn: string; amount?: number }) => {
      guardPreview();
      const { chargeGuestDepositWithMpesa } = await import("@/lib/mpesa.functions");
      const result = await chargeGuestDepositWithMpesa({ data: { organizationId, reference, msisdn: input.msisdn, ...(input.amount === undefined ? {} : { amount: input.amount }) } });
      if (!result.ok) throw new Error(result.detail);
      return { ok: true, transaction_id: result.transactionId ?? "", amount: result.amount ?? input.amount ?? 0, detail: result.detail };
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["guest-booking-position", organizationId, reference] });
      void client.invalidateQueries({ queryKey: ["guest-reservations", organizationId] });
    },
  });
}
