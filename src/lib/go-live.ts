import { guardedRpc } from "@/lib/rpc-guard";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useActivePropertyFilter } from "@/lib/branch-filter";

const db = supabase as unknown as {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

/** Readiness verdicts used across the go-live surface. */
export type ReadinessStatus = "ready" | "attention" | "blocked" | "unknown";

export type ReadinessCheck = {
  key: string;
  domain: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  count: number;
  route: string;
  extra?: Record<string, unknown>;
};

export type GoLiveReadiness = {
  branch_id: string | null;
  generated_at: string;
  status: ReadinessStatus;
  checks: ReadinessCheck[];
};

export const readinessLabels: Record<ReadinessStatus, string> = {
  ready: "Ready",
  attention: "Needs attention",
  blocked: "Blocked",
  unknown: "Unknown",
};

/**
 * Whole-workspace go-live readiness. Every check is evaluated server side
 * against the canonical business relationships (POS → KDS, menu → recipe →
 * station, employee → rider, event → billing, finance periods, approvals) and
 * is scoped to the active property selection.
 */
export function useGoLiveReadiness() {
  const { branchId, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["go-live", "readiness", filterKey],
    queryFn: async (): Promise<GoLiveReadiness> => {
      const { data, error } = await guardedRpc(db, "neo_go_live_readiness", { _branch: branchId });
      if (error) throw new Error(error.message);
      const payload = (data ?? {}) as Partial<GoLiveReadiness>;
      return {
        branch_id: payload.branch_id ?? null,
        generated_at: payload.generated_at ?? new Date().toISOString(),
        status: payload.status ?? "unknown",
        checks: Array.isArray(payload.checks) ? payload.checks : [],
      };
    },
    // Readiness is re-evaluated on its own while the screen is open.
    refetchInterval: 2 * 60 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

/** Validation state of every imported menu item for the active property. */
export type MenuValidationState =
  | "ready"
  | "missing-mapping"
  | "missing-recipe"
  | "missing-image"
  | "invalid-relationship"
  | "draft";

export type MenuValidationRow = {
  item_id: string;
  branch_id: string | null;
  name: string;
  state: MenuValidationState;
  issues: string[];
};

export const menuStateLabels: Record<MenuValidationState, string> = {
  ready: "Ready",
  "missing-mapping": "Missing mapping",
  "missing-recipe": "Missing recipe",
  "missing-image": "Missing image",
  "invalid-relationship": "Invalid relationship",
  draft: "Draft",
};

export const menuIssueLabels: Record<string, string> = {
  "missing-station": "No production station",
  "missing-category": "No menu category",
  "missing-image": "No item image",
  "missing-recipe": "No active recipe",
  "incomplete-recipe": "Recipe has no ingredients",
  "missing-price": "No selling price",
  draft: "Not published",
};

export function useMenuValidationStates() {
  const { branchId, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["go-live", "menu-validation", filterKey],
    queryFn: async (): Promise<MenuValidationRow[]> => {
      const { data, error } = await guardedRpc(db, "neo_menu_validation_states", { _branch: branchId });
      if (error) throw new Error(error.message);
      return ((data ?? []) as MenuValidationRow[]).map((row) => ({
        ...row,
        issues: Array.isArray(row.issues) ? row.issues : [],
      }));
    },
    refetchInterval: 2 * 60 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
