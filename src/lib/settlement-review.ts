/**
 * Settlement account review.
 *
 * A receipt has to land in the account that matches how the money was taken:
 * cash in the cash account, M-Pesa in the M-Pesa account, a card in card
 * clearing. Where a posted receipt disagrees with its own payment method, it is
 * listed here rather than quietly corrected. Correcting one posts a new dated
 * entry with a written reason — the original entry is never rewritten.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export type SettlementReviewRow = {
  journal_id: string;
  journal_number: string;
  line_id: string;
  accounting_date: string;
  branch_id: string | null;
  description: string;
  method: string;
  amount: number;
  side: "debit" | "credit";
  current_code: string;
  current_account: string;
  expected_code: string;
  expected_account: string;
  expected_account_id: string;
  already_reclassified: boolean;
};

export function useSettlementReview(from?: string) {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["finance", "settlement-review", organizationId, branchId ?? "all", from ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc<SettlementReviewRow[]>(
        supabase,
        "neo_gl_settlement_review",
        { _branch: branchId ?? null, _from: from ?? null, _to: null },
      );
      if (error) throw error;
      return (data ?? []) as SettlementReviewRow[];
    },
  });
}

export function useReclassifySettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { lineId: string; reason: string }) => {
      const { data, error } = await guardedRpc(supabase, "neo_gl_reclassify_settlement", {
        _line: input.lineId,
        _reason: input.reason,
        _date: null,
      });
      if (error) throw error;
      return data as { journal_number?: string; already_reclassified?: boolean };
    },
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ["finance"] });
      if (result?.already_reclassified) {
        toast.info("Already corrected", {
          description: "A correcting entry for this receipt exists already.",
        });
        return;
      }
      toast.success("Receipt moved to the right account", {
        description: result?.journal_number
          ? `Correcting entry ${result.journal_number} posted.`
          : "A correcting entry has been posted.",
      });
    },
    onError: (e: Error) =>
      toast.error("Could not move the receipt", { description: e.message }),
  });
}

export const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  mpesa: "M-Pesa",
  "m-pesa": "M-Pesa",
  m_pesa: "M-Pesa",
  mobile_money: "Mobile money",
  bank: "Bank",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  card: "Card",
  credit_card: "Card",
  debit_card: "Card",
};
