/**
 * Guest-facing experiences.
 *
 * The hotel already publishes its spa, wellness, excursion and celebration
 * packages in the events catalogue. This is the same catalogue, read through a
 * guest-safe routine that returns only active, in-date, published packages for
 * one property. Nothing here is illustrative: a hotel that has published no
 * package shows an honest empty state.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

export type PublicExperience = {
  id: string;
  name: string;
  description: string | null;
  price: number | null;
  price_basis: string | null;
  tax_rate: number | null;
  min_guests: number | null;
  max_guests: number | null;
  valid_to: string | null;
  event_type: string | null;
};

/** How the price is charged, in words a guest understands. */
export function experienceBasis(basis: string | null | undefined): string {
  switch ((basis ?? "").toLowerCase()) {
    case "per_person":
    case "per-person":
      return "per person";
    case "per_event":
    case "per-event":
      return "per booking";
    case "per_hour":
    case "per-hour":
      return "per hour";
    case "per_day":
    case "per-day":
      return "per day";
    default:
      return "";
  }
}

/** Guest capacity written as a short sentence, or null when unrestricted. */
export function experienceGuests(min: number | null, max: number | null): string | null {
  if (min && max) return `${min}–${max} guests`;
  if (max) return `Up to ${max} guests`;
  if (min) return `From ${min} guests`;
  return null;
}

export function usePublicExperiences(branchId: string | undefined) {
  return useQuery({
    queryKey: ["public-experiences", branchId],
    enabled: Boolean(branchId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<PublicExperience[]> => {
      const { data, error } = await guardedRpc(supabase, "neo_public_experiences", { _branch: branchId });
      if (error) throw new Error(error.message);
      return (data ?? []) as PublicExperience[];
    },
  });
}
