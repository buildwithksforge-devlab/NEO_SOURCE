/**
 * Guest notifications.
 *
 * Every row is written by the database when a real operational event happens —
 * a booking is confirmed, a room is ready, an order is accepted, laundry is
 * collected. Nothing here is generated in the browser, so the inbox can only
 * ever show things that actually took place.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

const sb = supabase as unknown as {
  from: (table: string) => any;
  rpc: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export type GuestNotification = {
  id: string;
  organization_id: string;
  category: string;
  event_type: string;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read_at: string | null;
};

export const guestNotificationCategories: Record<string, string> = {
  stay: "Stay",
  order: "Orders",
  laundry: "Laundry",
};

export function guestNotificationCategoryLabel(category: string) {
  return guestNotificationCategories[category] ?? "Updates";
}

/** Where a notification points, expressed as a route this app actually has. */
export type GuestNotificationTarget =
  | { kind: "order"; reference: string }
  | { kind: "reservation"; reference: string }
  | { kind: "orders" }
  | { kind: "laundry" }
  | { kind: "trips" }
  | null;

export function guestNotificationTarget(link: string | null | undefined): GuestNotificationTarget {
  if (!link) return null;
  const [head, ...rest] = link.split("/");
  const reference = rest.join("/").trim();
  if (head === "orders" && reference) return { kind: "order", reference };
  if (head === "reservations" && reference) return { kind: "reservation", reference };
  if (head === "orders") return { kind: "orders" };
  if (head === "laundry") return { kind: "laundry" };
  if (head === "trips") return { kind: "trips" };
  return null;
}

const key = (organizationId: string, customerId?: string | null) => [
  "guest-notifications",
  organizationId,
  customerId ?? "none",
];

export function useGuestNotifications(organizationId: string, customerId?: string | null) {
  return useQuery({
    queryKey: key(organizationId, customerId),
    enabled: Boolean(organizationId && customerId),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from("guest_notifications")
        .select("id, organization_id, category, event_type, title, body, link, created_at, read_at")
        .eq("organization_id", organizationId)
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(60);
      if (error) throw new Error(error.message);
      return (data ?? []) as GuestNotification[];
    },
  });
}

export function unreadCount(rows: GuestNotification[] | undefined) {
  return (rows ?? []).filter((row) => !row.read_at).length;
}

export function useMarkGuestNotifications(organizationId: string, customerId?: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (!customerId || ids.length === 0) return;
      const { error } = await sb
        .from("guest_notifications")
        .update({ read_at: new Date().toISOString() })
        .in("id", ids);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: key(organizationId, customerId) });
    },
  });
}

/* ------------------------------------------------- hotels this guest knows */

export type GuestHotel = {
  organization_id: string;
  branch_id: string;
  public_slug: string;
  display_name: string | null;
  cover_image_url: string | null;
  stays: number;
  last_activity: string | null;
};

/** Properties the signed-in person already has a guest record with. */
export function useMyGuestHotels(enabled: boolean) {
  return useQuery({
    queryKey: ["guest-my-hotels", enabled],
    enabled,
    staleTime: 300_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(sb, "neo_guest_my_hotels", {});
      if (error) throw new Error(error.message);
      return (data ?? []) as GuestHotel[];
    },
  });
}
