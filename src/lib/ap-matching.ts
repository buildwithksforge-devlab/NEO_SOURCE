/**
 * Accounts payable matching and journal register.
 *
 * The database is the authority: `neo_ap_journal_register` returns each payable
 * with the journal it produced (including debit and credit totals), and
 * `neo_ap_match_lines` returns the line-level agreement between the purchase
 * order, the goods received and the invoice. Nothing is recomputed here, so a
 * refresh, a reopen or a new session reads the same verdict.
 */
import { useQuery } from "@tanstack/react-query";
import { guardedRpc } from "@/lib/rpc-guard";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type ApRegisterRow = {
  invoice_id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  supplier_name: string | null;
  property: string | null;
  order_id: string | null;
  order_number: string | null;
  receipt_id: string | null;
  grn_number: string | null;
  amount: number;
  tax_amount: number;
  matched_amount: number;
  paid_amount: number;
  variance: number;
  status: string;
  match_status: string;
  exception_count: number;
  critical_count: number;
  line_count: number;
  journal_id: string | null;
  journal_number: string | null;
  journal_status: string | null;
  accounting_date: string | null;
  total_debit: number;
  total_credit: number;
  balanced: boolean;
  posted_at: string | null;
};

export type ApMatchLine = {
  line_id: string;
  line_number: number | null;
  description: string;
  ordered_quantity: number;
  accepted_quantity: number;
  received_quantity: number;
  other_invoiced_quantity: number;
  claimable_quantity: number;
  invoiced_quantity: number;
  order_unit_price: number;
  invoiced_unit_price: number;
  quantity_variance: number;
  price_variance: number;
  line_total: number;
  match_state: "matched" | "variance" | "exception";
  detail: string;
};

/** A payable may only be created once matching is no longer held. */
export function payableBlocked(row: { match_status?: string | null } | null | undefined) {
  return String(row?.match_status ?? "") === "held";
}

export function useApJournalRegister(matchStatus = "all") {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["finance", "ap-register", organizationId, branchId ?? "all", matchStatus],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<ApRegisterRow[]> => {
      const { data, error } = await guardedRpc(db, "neo_ap_journal_register", {
        _branch: branchId,
        _match_status: matchStatus === "all" ? null : matchStatus,
      });
      if (error) throw new Error(error.message);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((data ?? []) as any[]).map((r) => ({
        invoice_id: String(r.invoice_id),
        invoice_number: r.invoice_number ?? null,
        invoice_date: r.invoice_date ?? null,
        due_date: r.due_date ?? null,
        supplier_name: r.supplier_name ?? null,
        property: r.property ?? null,
        order_id: r.order_id ?? null,
        order_number: r.order_number ?? null,
        receipt_id: r.receipt_id ?? null,
        grn_number: r.grn_number ?? null,
        amount: Number(r.amount ?? 0),
        tax_amount: Number(r.tax_amount ?? 0),
        matched_amount: Number(r.matched_amount ?? 0),
        paid_amount: Number(r.paid_amount ?? 0),
        variance: Number(r.variance ?? 0),
        status: String(r.status ?? "draft"),
        match_status: String(r.match_status ?? "unmatched"),
        exception_count: Number(r.exception_count ?? 0),
        critical_count: Number(r.critical_count ?? 0),
        line_count: Number(r.line_count ?? 0),
        journal_id: r.journal_id ?? null,
        journal_number: r.journal_number ?? null,
        journal_status: r.journal_status ?? null,
        accounting_date: r.accounting_date ?? null,
        total_debit: Number(r.total_debit ?? 0),
        total_credit: Number(r.total_credit ?? 0),
        balanced: Boolean(r.balanced),
        posted_at: r.posted_at ?? null,
      }));
    },
  });
}

export function useApMatchLines(invoiceId: string | null | undefined) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["finance", "ap-match-lines", organizationId, invoiceId ?? "none"],
    enabled: Boolean(organizationId) && Boolean(invoiceId),
    queryFn: async (): Promise<ApMatchLine[]> => {
      const { data, error } = await guardedRpc(db, "neo_ap_match_lines", { _invoice: invoiceId });
      if (error) throw new Error(error.message);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((data ?? []) as any[]).map((r) => ({
        line_id: String(r.line_id),
        line_number: r.line_number ?? null,
        description: String(r.description ?? "Item"),
        ordered_quantity: Number(r.ordered_quantity ?? 0),
        accepted_quantity: Number(r.accepted_quantity ?? 0),
        received_quantity: Number(r.received_quantity ?? 0),
        other_invoiced_quantity: Number(r.other_invoiced_quantity ?? 0),
        claimable_quantity: Number(r.claimable_quantity ?? 0),
        invoiced_quantity: Number(r.invoiced_quantity ?? 0),
        order_unit_price: Number(r.order_unit_price ?? 0),
        invoiced_unit_price: Number(r.invoiced_unit_price ?? 0),
        quantity_variance: Number(r.quantity_variance ?? 0),
        price_variance: Number(r.price_variance ?? 0),
        line_total: Number(r.line_total ?? 0),
        match_state: (r.match_state ?? "matched") as ApMatchLine["match_state"],
        detail: String(r.detail ?? ""),
      }));
    },
  });
}
