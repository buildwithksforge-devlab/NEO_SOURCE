/**
 * Charging a guest request to the stay.
 *
 * The posting itself is done by the canonical folio charge routine, so a
 * request charge behaves exactly like any other charge on the guest's folio:
 * same numbering, same tax handling, same audit trail, and the same
 * idempotency key so a request can never be charged twice.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

export type RequestChargeResult = {
  ok?: boolean;
  reason?: string;
  folio_number?: string;
  total?: number;
};

export function requestChargeFailure(reason?: string): string {
  switch (reason) {
    case "not_signed_in":
      return "Please sign in again to post this charge.";
    case "not_permitted":
      return "Your role cannot post charges to a guest folio.";
    case "unknown_request":
      return "That request is no longer available.";
    case "no_stay":
      return "This request is not attached to a stay, so there is no folio to charge.";
    case "no_open_folio":
      return "This stay has no open folio. Reopen the folio before charging.";
    case "no_amount":
      return "Enter a quantity and a price above zero.";
    case "no_description":
      return "Describe what is being charged.";
    default:
      return "The charge could not be posted.";
  }
}

export function useChargeRequestToFolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      request: string;
      description: string;
      quantity: number;
      unitPrice: number;
      taxRate: number;
      reason?: string;
    }) => {
      const { data, error } = await guardedRpc(supabase, "neo_request_charge_post", {
        _request: input.request,
        _description: input.description,
        _quantity: input.quantity,
        _unit_price: input.unitPrice,
        _tax_rate: input.taxRate,
        _reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as RequestChargeResult;
      if (!result.ok) throw new Error(requestChargeFailure(result.reason));
      return result;
    },
    onSuccess: (result) => {
      toast.success(
        `Charged to folio ${result.folio_number ?? ""}`.trim() +
          (result.total ? ` — ${result.total.toLocaleString()}` : ""),
      );
      void queryClient.invalidateQueries({ queryKey: ["guest-requests"] });
      void queryClient.invalidateQueries({ queryKey: ["folio"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
