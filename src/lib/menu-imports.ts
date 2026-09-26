import { guardedRpc } from "@/lib/rpc-guard";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

/**
 * Menu import provenance.
 *
 * `neo_menu_import_batches` is the only reader of import history: it reports
 * each batch, whether a later batch superseded it, how many of its rows are
 * still live versus preserved as history, and where the routing of those rows
 * actually comes from. It is capability-checked (`pos.menu.view`) and scoped to
 * the caller's properties, so a batch from another property is never returned.
 */
export type MenuImportBatch = {
  batch_id: string;
  file_name: string | null;
  file_type: string | null;
  reference: string | null;
  status: string;
  branch_id: string | null;
  branch_name: string | null;
  menu_id: string | null;
  menu_name: string | null;
  total_rows: number | null;
  imported_rows: number | null;
  committed_rows: number | null;
  rejected_rows: number | null;
  duplicate_rows: number | null;
  created_at: string;
  created_by_name: string | null;
  superseded: boolean;
  superseded_by: string | null;
  supersedes: string | null;
  item_rows: number;
  live_rows: number;
  historical_rows: number;
  published_rows: number;
  draft_rows: number;
  unrouted_rows: number;
  station_summary: Record<string, number>;
  source_summary: Record<string, number>;
};

export function useMenuImportBatches() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["pos", "menu-import-batches", organizationId, branchId ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_menu_import_batches", {
        _branch: branchId,
      } as never);
      if (error) throw error;
      return (data ?? []) as unknown as MenuImportBatch[];
    },
  });
}

/** Human wording for the routing source keys the resolver emits. */
export const ROUTING_SOURCE_LABEL: Record<string, string> = {
  item_rule: "Item routing rule",
  category_rule: "Category routing rule",
  item_default: "Item default station",
  category_default: "Category default station",
  none: "No routing resolved",
};
