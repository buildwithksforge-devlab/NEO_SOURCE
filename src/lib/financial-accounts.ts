import { guardedRpc } from "@/lib/rpc-guard";
import { useQuery } from "@tanstack/react-query";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

export type ReceivingAccount = {
  id: string;
  name: string;
  account_kind: string | null;
  currency: string | null;
  gl_code: string | null;
  is_default: boolean | null;
};

/**
 * The hotel's own bank, cash, till, card and mobile-money accounts for the
 * property in context.
 *
 * NEØ keeps two ideas apart: the payment *method* is how the guest paid, while
 * the financial *account* is where that money actually landed, is held, cleared
 * or paid from. Every money entry point — front desk, restaurant, bar, events,
 * delivery, receivables and supplier payments — reads this one list so the
 * receipt, the journal, the ledger balance and the reports all agree.
 */
export function useReceivingAccounts() {
  const { branchId, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["finance", "receiving-accounts", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_financial_accounts", {
        _branch: branchId ?? null,
      });
      if (error) throw error;
      return (data ?? []) as ReceivingAccount[];
    },
  });
}
