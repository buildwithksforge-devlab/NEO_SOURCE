/**
 * Live delivery tracking.
 *
 * Two sides of one canonical contract, both enforced in the database:
 *
 *  - the rider app reports its own position while it is actually carrying an
 *    active delivery for a property that has tracking switched on;
 *  - the customer reads their own delivery — destination, instructions,
 *    courier and the courier's latest position — and nothing else.
 *
 * There is no map provider, no routing service and no stored travel history
 * here: a position is a temporary operational fact that the property's own
 * retention setting expires.
 */
import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

const sb = supabase as unknown as {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export type CourierLocation = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  captured_at: string;
};

export type DeliveryLive = {
  order_number: string;
  order_status: string;
  fulfilment_type: string;
  live: boolean;
  estimated_delivery_at: string | null;
  delivered_at: string | null;
  delivery_fee: number | null;
  tracking_enabled: boolean;
  refresh_seconds: number;
  destination: {
    label: string | null;
    address_line: string | null;
    city: string | null;
    landmark: string | null;
    instructions: string | null;
    recipient_name: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  courier: {
    display_name: string;
    vehicle_type: string | null;
    vehicle_registration: string | null;
    phone: string | null;
  } | null;
  courier_location: CourierLocation | null;
};

/** A position older than this is shown as last known, never as "now". */
export const STALE_LOCATION_SECONDS = 180;

export function locationAgeSeconds(location?: CourierLocation | null): number | null {
  if (!location?.captured_at) return null;
  const at = new Date(location.captured_at).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((Date.now() - at) / 1000));
}

/** The customer's own delivery. The routine refuses anyone else's reference. */
export function useDeliveryLive(organizationId: string, reference?: string) {
  return useQuery({
    queryKey: ["delivery-live", organizationId, reference ?? "none"],
    enabled: Boolean(organizationId && reference),
    refetchInterval: (query) => {
      const data = query.state.data as DeliveryLive | null | undefined;
      if (!data?.live) return false;
      return Math.max(10, data.refresh_seconds ?? 30) * 1000;
    },
    queryFn: async () => {
      const { data, error } = await guardedRpc(sb, "neo_guest_delivery_live", {
        _org: organizationId,
        _reference: reference,
      });
      if (error) throw new Error(error.message);
      return (data as DeliveryLive | null) ?? null;
    },
  });
}

export function useReportRiderLocation() {
  return useMutation({
    mutationFn: async (input: {
      deliveryId: string;
      latitude: number;
      longitude: number;
      accuracy?: number | null;
      heading?: number | null;
      speed?: number | null;
    }) => {
      const { data, error } = await guardedRpc(sb, "neo_rider_report_location", {
        _delivery: input.deliveryId,
        _lat: input.latitude,
        _lng: input.longitude,
        _accuracy: input.accuracy ?? null,
        _heading: input.heading ?? null,
        _speed: input.speed ?? null,
      });
      if (error) throw new Error(error.message);
      return (data as { ok: boolean; detail?: string; next_ping_seconds?: number } | null) ?? null;
    },
  });
}

/**
 * Shares the rider's position for the deliveries they are currently carrying.
 * Sharing stops the moment there is no active delivery, so the app never
 * follows a rider who is off a run. The database refuses a position for a
 * property that has tracking switched off, and this hook then stands down.
 */
export function useRiderLocationSharing(activeDeliveryIds: string[], intervalSeconds = 30) {
  const report = useReportRiderLocation();
  const idsRef = useRef<string[]>(activeDeliveryIds);
  const stoppedRef = useRef(false);
  idsRef.current = activeDeliveryIds;
  const enabled = activeDeliveryIds.length > 0;
  const key = activeDeliveryIds.join(",");
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    stoppedRef.current = false;
    let cancelled = false;

    const send = () => {
      if (cancelled || stoppedRef.current) return;
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (cancelled || stoppedRef.current) return;
          for (const deliveryId of idsRef.current) {
            reportRef.current
              .mutateAsync({
                deliveryId,
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy ?? null,
                heading: Number.isFinite(position.coords.heading ?? NaN) ? position.coords.heading : null,
                speed: Number.isFinite(position.coords.speed ?? NaN) ? position.coords.speed : null,
              })
              .then((result) => {
                // The property switched tracking off, or this run ended:
                // stand down instead of retrying on a timer.
                if (result && !result.ok && result.detail === "tracking_disabled") stoppedRef.current = true;
              })
              .catch(() => undefined);
          }
        },
        () => undefined,
        { enableHighAccuracy: true, maximumAge: 15_000, timeout: 15_000 },
      );
    };

    send();
    const timer = window.setInterval(send, Math.max(10, intervalSeconds) * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, key, intervalSeconds]);

  return { sharing: enabled && !stoppedRef.current };
}
