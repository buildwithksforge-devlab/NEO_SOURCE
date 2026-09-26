/**
 * Partner credit invoicing and the hotel side of partner messaging.
 *
 * A credit invoice is a real receivable: it creates an invoice with its lines,
 * posts the receivable to the ledger through the canonical journal routine, and
 * tells the partner in the same Messages thread they already use. Nothing is
 * estimated here — every amount comes from what the person raising the invoice
 * types, and the routine refuses plainly when the property has no receivable,
 * revenue or VAT account configured.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import type { PartnerThread } from "@/lib/partner-messaging";

export type PartnerInvoiceLine = {
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
};

export function invoiceFailure(reason?: string): string {
  switch (reason) {
    case "not_signed_in":
      return "Please sign in again to raise this invoice.";
    case "not_permitted":
      return "Your role cannot raise invoices.";
    case "unknown_relationship":
      return "That partner is no longer available on this property.";
    case "not_a_credit_account":
      return "This partner has no corporate credit account, so they cannot be invoiced on credit.";
    case "no_lines":
    case "invalid_line":
      return "Every line needs a description, a quantity and a price above zero.";
    case "no_property":
      return "This partner is not attached to a property.";
    case "no_receivable_account":
      return "This property has no Accounts Receivable account configured.";
    case "no_revenue_account":
      return "This property has no revenue account configured.";
    case "no_vat_account":
      return "This property has no VAT Payable account configured, so a taxed invoice cannot be posted.";
    default:
      return "The invoice could not be raised.";
  }
}

export function useRaisePartnerInvoice(relationshipId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      lines: PartnerInvoiceLine[];
      due?: string | null;
      notes?: string;
      message?: string;
    }) => {
      const { data, error } = await guardedRpc(supabase, "neo_partner_invoice_raise", {
        _relationship: relationshipId,
        _lines: input.lines,
        _due: input.due || null,
        _notes: input.notes ?? null,
        _message: input.message ?? null,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as {
        ok?: boolean;
        reason?: string;
        invoice_number?: string;
        total?: number;
      };
      if (!result.ok) throw new Error(invoiceFailure(result.reason));
      return result;
    },
    onSuccess: (result) => {
      toast.success(`Invoice ${result.invoice_number ?? ""} sent to the partner`.trim());
      void queryClient.invalidateQueries({ queryKey: ["hotel-partner-threads", relationshipId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useHotelPartnerThreads(relationshipId: string | null) {
  return useQuery({
    queryKey: ["hotel-partner-threads", relationshipId],
    enabled: Boolean(relationshipId),
    queryFn: async (): Promise<PartnerThread[]> => {
      const { data, error } = await guardedRpc(supabase, "neo_hotel_partner_threads", {
        _relationship: relationshipId,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as { allowed?: boolean; threads?: PartnerThread[] };
      if (!result.allowed) return [];
      return result.threads ?? [];
    },
  });
}

export function useHotelPartnerSend(relationshipId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { body: string; threadId?: string | null; subject?: string }) => {
      const { data, error } = await guardedRpc(supabase, "neo_hotel_partner_send", {
        _relationship: relationshipId,
        _body: input.body,
        _thread: input.threadId ?? null,
        _subject: input.subject ?? null,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as { ok?: boolean; reason?: string };
      if (!result.ok) throw new Error(invoiceFailure(result.reason));
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["hotel-partner-threads", relationshipId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** What the partner sees: credit invoices raised against their own account. */
export function usePartnerCreditInvoices(branchId: string | null, relationshipId: string | null) {
  return useQuery({
    queryKey: ["partner-credit-invoices", branchId, relationshipId],
    enabled: Boolean(branchId && relationshipId),
    queryFn: async (): Promise<Record<string, unknown>[]> => {
      const { data, error } = await guardedRpc(supabase, "neo_partner_credit_invoices", {
        _branch: branchId,
        _relationship: relationshipId,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as { allowed?: boolean; invoices?: Record<string, unknown>[] };
      if (!result.allowed) return [];
      return result.invoices ?? [];
    },
  });
}
