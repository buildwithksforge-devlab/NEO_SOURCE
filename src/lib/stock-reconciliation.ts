import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import type { Row } from "@/lib/inventory";

/**
 * Insufficient-stock reconciliation.
 *
 * The canonical policy in `inventory_apply_movement` is deliberate: a
 * consumption posting is never silently reduced or partially applied. It posts
 * the full recipe requirement and, when the store did not actually hold it, the
 * balance goes negative rather than quietly deducting a smaller amount. That
 * makes the shortfall visible and auditable instead of invisible.
 *
 * This read surfaces those outcomes — it does not change stock, and it never
 * posts a compensating movement.
 */
export function useInsufficientStockOutcomes() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["inventory", "insufficient-stock", organizationId, branchId ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_levels")
        .select(
          "id, quantity_on_hand, last_movement_at, stock_item_id, location_id, stock_items!inner(name, base_unit, branch_id), stock_locations(name, branch_id)",
        )
        .lt("quantity_on_hand", 0)
        .order("quantity_on_hand", { ascending: true })
        .limit(200);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Row[];
      if (!branchId) return rows;
      return rows.filter((row) => {
        const location = (row["stock_locations"] ?? null) as Row | null;
        const item = (row["stock_items"] ?? null) as Row | null;
        const locationBranch = location?.["branch_id"] ?? null;
        const itemBranch = item?.["branch_id"] ?? null;
        return (
          locationBranch === null ||
          locationBranch === branchId ||
          itemBranch === null ||
          itemBranch === branchId
        );
      });
    },
  });
}

/** Shortfall (positive number) implied by a negative balance row. */
export function shortfallOf(row: Row): number {
  const onHand = Number(row["quantity_on_hand"] ?? 0) || 0;
  return onHand < 0 ? Math.abs(onHand) : 0;
}
