import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * The official hotel role catalogue.
 *
 * It records, for every role in the hotel's approved structure, which
 * department it belongs to, who it answers to, whether the hotel runs one or
 * many of them, the access scope it is granted and — critically — whether it
 * may approve restricted actions. Only the Owner/Director and the Operations
 * Manager hold that authority; everybody else can submit a request only.
 */
export type CatalogueRole = {
  role_key: string;
  role_name: string;
  department: string;
  reports_to_key: string | null;
  multiplicity: "single" | "multiple" | "optional" | string;
  access_scope: string;
  restricted_authority: boolean;
  optional_role: boolean;
  sort_order: number;
  summary: string;
  /** Historical roles stay in the catalogue for audit but are not current. */
  retired?: boolean;
};

export type RestrictedAction = { module: string; action: string; reason: string };

export const accessScopeLabels: Record<string, string> = {
  organisation: "Whole organisation",
  branch: "Whole property",
  department: "Their department",
  team: "Their team",
  self: "Their own work",
  technical: "Technical configuration only",
};

export const multiplicityLabels: Record<string, string> = {
  single: "One user",
  multiple: "Multiple users",
  optional: "Optional",
};

export function useRoleCatalogue() {
  return useQuery({
    queryKey: ["role-catalogue"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_catalogue" as never)
        .select("*")
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as unknown as CatalogueRole[];
    },
  });
}

export function useRestrictedActions() {
  return useQuery({
    queryKey: ["restricted-actions"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("restricted_actions" as never).select("*");
      if (error) throw error;
      return (data ?? []) as unknown as RestrictedAction[];
    },
  });
}

/** Distinct reasons a restricted action exists, for display. */
export function restrictedReasons(actions: RestrictedAction[]) {
  return Array.from(new Set(actions.map((a) => a.reason))).filter(Boolean).sort();
}
