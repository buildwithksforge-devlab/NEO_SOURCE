/**
 * Arrival tracking for the public entrances.
 *
 * When someone reaches a property through a link on the hotel's own website, a
 * campaign, a QR code or the NEØ front door, that arrival is recorded against
 * the property so the hotel can see where its customers come from. Only the
 * entrance, the link tags and the referring site are stored — never a name, an
 * address or anything identifying the visitor. One arrival is kept per visitor
 * session, entrance and day, so refreshing a page does not inflate the count.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

export type EntryDoor = "discover" | "stay_dine" | "delivery" | "partner" | "rider" | "work";

const SESSION_STORAGE_KEY = "neo.visit.session";

function visitorSession(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return null;
  }
}

/** Records one arrival at a property entrance. Safe to call on every render. */
export function useTrackEntry(slug: string | null | undefined, door: EntryDoor) {
  useEffect(() => {
    if (!slug || typeof window === "undefined") return;
    const session = visitorSession();
    if (!session) return;
    const params = new URLSearchParams(window.location.search);
    const marked = `${SESSION_STORAGE_KEY}.${slug}.${door}`;
    if (window.sessionStorage.getItem(marked)) return;
    window.sessionStorage.setItem(marked, "1");

    // The query builder is lazy — it only runs once a handler is attached.
    guardedRpc(
        supabase,
        "neo_track_entry" as never,
        {
          _slug: slug,
          _door: door,
          _source: params.get("utm_source"),
          _medium: params.get("utm_medium"),
          _campaign: params.get("utm_campaign"),
          _referrer: document.referrer || null,
          _path: window.location.pathname,
          _session: session,
        } as never,
      )
      .then(
        () => undefined,
        () => undefined,
      );
  }, [slug, door]);
}

export type TrafficSummary = {
  allowed: boolean;
  reason?: string;
  total?: number;
  by_door?: { door: string; visits: number }[];
  by_source?: { source: string; medium: string; campaign: string; visits: number }[];
  by_referrer?: { referrer: string; visits: number }[];
  by_day?: { day: string; visits: number }[];
};

/** Arrival counts for a property the signed-in person is already permitted to see. */
export function useTrafficSummary(branchId: string | null) {
  return useQuery({
    queryKey: ["neo-traffic-summary", branchId],
    enabled: Boolean(branchId),
    queryFn: async (): Promise<TrafficSummary> => {
      const { data, error } = await guardedRpc(
        supabase,
        "neo_traffic_summary" as never,
        {
          _branch: branchId,
        } as never,
      );
      if (error) throw new Error(error.message);
      return (data ?? { allowed: false }) as TrafficSummary;
    },
  });
}
