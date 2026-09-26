/**
 * Configuration health.
 *
 * A read-only scan, property by property, of the settings an operating
 * property cannot work without: stations, stores, the link between them,
 * stock items, how each menu item consumes stock, recipes, bottle sizes and
 * a connected payment provider.
 *
 * Nothing here fills anything in. Every finding carries the screen where a
 * person makes the decision, because a missing bottle size or a missing
 * recipe is a business fact the system must not invent.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

const sb = supabase as unknown as {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export type HealthCheck = {
  code: string;
  label: string;
  detail: string;
  count: number;
  severity: "critical" | "warning";
  fix_route: string;
  fix_label: string;
};

export type PropertyHealth = {
  branch_id: string;
  branch_name: string;
  stations: number;
  stores: number;
  stock_items: number;
  menu_items: number;
  issues: number;
  checks: HealthCheck[];
};

export type ConfigurationHealth = {
  properties: PropertyHealth[];
  mpesa_enabled: boolean;
  provider_connections: number;
};

export function useConfigurationHealth(branchId?: string | null) {
  return useQuery({
    queryKey: ["configuration", "health", branchId ?? "all"],
    queryFn: async (): Promise<ConfigurationHealth> => {
      const { data, error } = await guardedRpc(sb, "neo_configuration_health", { _branch: branchId ?? null });
      if (error) throw new Error(error.message);
      const payload = (data ?? {}) as {
        ok?: boolean;
        reason?: string;
        properties?: PropertyHealth[];
        mpesa_enabled?: boolean;
        provider_connections?: number;
      };
      if (!payload.ok) {
        throw new Error(
          payload.reason === "no_organisation"
            ? "Select a workspace to run the configuration check."
            : "The configuration check is unavailable.",
        );
      }
      return {
        properties: payload.properties ?? [],
        mpesa_enabled: Boolean(payload.mpesa_enabled),
        provider_connections: Number(payload.provider_connections ?? 0),
      };
    },
  });
}
