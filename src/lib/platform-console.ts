/**
 * NEØ Platform Console data access.
 *
 * This is the SaaS operator's surface, not a hotel's administration. It decides
 * which businesses and properties exist on NEØ and whether a property is
 * eligible to appear in public discovery. A hotel administrator can never reach
 * these routines: every one of them refuses unless the caller is a registered,
 * active NEØ platform operator.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

export type ConsoleProperty = {
  branch_id: string;
  name: string;
  city: string | null;
  country: string | null;
  active: boolean;
  public_slug: string | null;
  hotel_discovery: boolean;
  listing_state: "eligible" | "blocked";
  listing_reason: string | null;
  listed: boolean;
};

export type ConsoleEntitlement = {
  key: string;
  name: string | null;
  enabled: boolean;
  source: string;
};

export type ConsoleBusiness = {
  organization_id: string;
  name: string;
  legal_name: string | null;
  business_type: string | null;
  created_at: string;
  tenant_state: string;
  grace_until: string | null;
  entitlements: ConsoleEntitlement[];
  properties: ConsoleProperty[];
};

export type ConsoleSummary = {
  businesses: number;
  properties: number;
  listed: number;
  blocked: number;
  suspended_tenants: number;
};

export type PlatformConsole = {
  allowed: boolean;
  operators: number;
  businesses?: ConsoleBusiness[];
  summary?: ConsoleSummary;
};

export function usePlatformConsole() {
  return useQuery({
    queryKey: ["neo-platform-console"],
    queryFn: async (): Promise<PlatformConsole> => {
      const { data, error } = await guardedRpc(supabase, "neo_platform_console");
      if (error) throw new Error(error.message);
      return (data as unknown as PlatformConsole) ?? { allowed: false, operators: 0 };
    },
    staleTime: 30_000,
  });
}

export function useSetPropertyListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { branchId: string; state: "eligible" | "blocked"; reason?: string }) => {
      const { error } = await guardedRpc(supabase, "neo_platform_set_listing", {
        _branch: input.branchId,
        _state: input.state,
        _reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["neo-platform-console"] });
      void qc.invalidateQueries({ queryKey: ["neo-front-door"] });
    },
  });
}

/**
 * Registers the signed-in account as the first NEØ platform operator. The
 * database refuses this the moment any operator exists, so it is a one-time
 * bootstrap and never a way into an established platform.
 */
export function useClaimFirstOperator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_platform_claim_first_operator");
      if (error) throw new Error(error.message);
      const result = data as unknown as { ok: boolean; reason?: string };
      if (!result?.ok) throw new Error(result?.reason ?? "Could not register the first operator.");
      return result;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["neo-platform-console"] });
    },
  });
}

export type PropertyListingStatus = {
  branch_id: string;
  property_name: string;
  public_slug: string | null;
  tenant_active: boolean;
  property_active: boolean;
  platform_eligible: boolean;
  hotel_discovery: boolean;
  has_public_experience: boolean;
  publicly_discoverable: boolean;
};

/** The hotel's own view of why its property is, or is not, publicly listed. */
export function usePropertyListingStatus(branchId: string | null) {
  return useQuery({
    queryKey: ["neo-property-listing-status", branchId],
    enabled: Boolean(branchId),
    queryFn: async (): Promise<PropertyListingStatus | null> => {
      const { data, error } = await guardedRpc(supabase, "neo_property_listing_status", {
        _branch: branchId,
      });
      if (error) throw new Error(error.message);
      return (data as unknown as PropertyListingStatus) ?? null;
    },
    staleTime: 15_000,
  });
}
