import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export type OrderProductionTask = {
  ticket_id: string;
  ticket_item_id: string;
  station_id: string | null;
  status: string;
  remake_of_id: string | null;
  accepted_at: string | null;
  started_at: string | null;
  ready_at: string | null;
  collected_at: string | null;
  served_at: string | null;
};

export type OrderProductionCoverageItem = {
  order_item_id: string;
  commercial_status: string;
  primary_station_id: string | null;
  cancellation_pending: boolean;
  production_tasks: OrderProductionTask[];
};

export function verifyOrderProductionCoverage(
  data: unknown,
  orderId: string,
): OrderProductionCoverageItem[] {

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Production coverage was not confirmed.");
  }

  const result = data as Record<string, unknown>;

  if (
    result["ok"] !== true ||
    result["order_id"] !== orderId ||
    !Array.isArray(result["items"])
  ) {
    throw new Error("Production coverage does not match the order.");
  }

  const seen = new Set<string>();

  for (const item of result["items"]) {

    if (
      !item ||
      typeof item.order_item_id !== "string" ||
      typeof item.commercial_status !== "string" ||
      typeof item.cancellation_pending !== "boolean" ||
      !Array.isArray(item.production_tasks) ||
      seen.has(item.order_item_id)
    ) {
      throw new Error("Invalid production coverage evidence.");
    }

    seen.add(item.order_item_id);

    for (const task of item.production_tasks) {

      if (
        !task ||
        typeof task.ticket_id !== "string" ||
        typeof task.ticket_item_id !== "string" ||
        typeof task.status !== "string"
      ) {
        throw new Error("Invalid production task evidence.");
      }

    }

  }

  return result["items"] as OrderProductionCoverageItem[];
}

export function useOrderProductionCoverage(orderId: string) {

  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();

  return useQuery({

    queryKey: [
      "pos",
      "production-coverage",
      organizationId,
      branchId,
      orderId,
    ],

    enabled: Boolean(organizationId && orderId),

    refetchInterval: 10000,

    queryFn: async () => {

      const { data, error } = await guardedRpc(
        supabase,
        "neo_order_production_coverage",
        { _order: orderId } as never,
      );

      if (error) throw new Error(error.message);

      return verifyOrderProductionCoverage(data, orderId);

    },

  });

}