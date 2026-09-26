/**
 * Provider payment intents — the plug-in path for a card terminal or a QR app.
 *
 * A recorded tender (cash, bank transfer, a card slip keyed by hand) is written
 * straight down as money received, because the money moved outside NEØ and the
 * entry is the record of it. A provider-backed tender is different: NEØ asks the
 * processor and waits. That request is an *intent*, and only the processor's own
 * answer — delivered to the public callback with the intent's single-use token —
 * can turn it into money received, a decline, a cancellation or a reversal.
 *
 * Nothing here invents a processor. When none is connected for this workspace,
 * opening an intent fails with the exact reason, and the checkout says so.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { dispatchPaymentIntent, type GatewayDispatch } from "@/lib/payment-gateway.functions";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

export type PaymentIntentOpen = {
  ok: boolean;
  reason?: string;
  detail?: string;
  intent_id?: string;
  attempt_id?: string;
  provider?: string;
  environment?: string;
  /** Returned once so the operator can hand it to the processor's configuration. */
  callback_token?: string;
};

export type PaymentIntentStatus = {
  ok: boolean;
  reason?: string;
  state?: string;
  detail?: string | null;
  provider_reference?: string | null;
  amount?: number;
  method?: string;
  environment?: string | null;
};

export function useOpenPaymentIntent() {
  return useMutation({
    mutationFn: async (input: {
      module: string;
      sourceRecord?: string | null;
      method: string;
      amount: number;
      branchId?: string | null;
      currency?: string | null;
      reference?: string | null;
      linkTable?: "pos_payments" | "payments";
      linkId?: string;
    }) => {
      const { data, error } = await guardedRpc(supabase, "neo_payment_intent_open", {
        _module: input.module,
        _source_record: input.sourceRecord ?? null,
        _method: input.method,
        _amount: input.amount,
        _branch: input.branchId ?? null,
        _currency: input.currency ?? null,
        _reference: input.reference ?? null,
        _link_table: input.linkTable ?? null,
        _link_id: input.linkId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? { ok: false }) as PaymentIntentOpen;
    },
  });
}

/** Polls a live intent while the checkout waits for the processor to answer. */
export function usePaymentIntentStatus(intentId: string | null | undefined) {
  return useQuery<PaymentIntentStatus>({
    queryKey: ["payment-intent", intentId],
    enabled: Boolean(intentId),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state && state !== "requested" && state !== "pending" ? false : 4000;
    },
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_payment_intent_status", {
        _intent: intentId,
      });
      if (error) throw new Error(error.message);
      return (data ?? { ok: false }) as PaymentIntentStatus;
    },
  });
}

/**
 * Sends the opened intent to the configured processor. The answer to this call
 * is only "did the request reach them" — never "was the money taken".
 */
export function useDispatchPaymentIntent() {
  const dispatch = useServerFn(dispatchPaymentIntent);
  return useMutation({
    mutationFn: async (input: { intentId: string }): Promise<GatewayDispatch> =>
      await dispatch({ data: { intentId: input.intentId } }),
  });
}
