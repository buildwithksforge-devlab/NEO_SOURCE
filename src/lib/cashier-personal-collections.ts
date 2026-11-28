import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import type {
  CashierCollectionRow,
} from "@/lib/cashier-collection-analysis";

export function useCashierPersonalCollections(
  from: string,
  to: string
) {
  const { user, organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();

  return useQuery({
    queryKey: [
      "cashier-personal-collections",
      organizationId,
      branchId,
      user?.id,
      from,
      to,
    ],

    enabled: Boolean(
      user?.id &&
      organizationId &&
      branchId &&
      from &&
      to &&
      from < to
    ),

    queryFn: async () => {
      if (!user?.id || !organizationId || !branchId) {
        throw new Error("Select an authorised property first.");
      }

      if (
        !Number.isFinite(Date.parse(from)) ||
        !Number.isFinite(Date.parse(to)) ||
        Date.parse(from) >= Date.parse(to) ||
        Date.parse(to) - Date.parse(from) > 366 * 86400000
      ) {
        throw new Error("Choose a valid collection reporting period.");
      }

      // Read-only query. Existing database RLS remains authoritative.
      const db = supabase as any;

      const { data, error } = await db.rpc(
        "neo_cashier_personal_collection_history",
        {
          _branch: branchId,
          _from: from,
          _to: to,
        }
      );

      if (error) throw new Error(error.message);

      if (!Array.isArray(data)) {
        throw new Error(
          "Unexpected collection history response."
        );
      }

      return data as CashierCollectionRow[];
    },

    refetchInterval: 30000,
  });
}