/**
 * Courier dispatch, from the browser's side.
 *
 * Opening a job records the intention to use a courier; sending it hands the job
 * to whichever courier service is configured. Neither of those moves the order —
 * only the courier's own answer, arriving on the callback, does that.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { dispatchCourierJob, type CourierDispatchResult } from "@/lib/delivery-gateway.functions";

export type CourierJob = {
  id: string;
  delivery_order_id: string;
  state: string;
  state_detail: string | null;
  provider_reference: string | null;
  environment: string;
  requested_at: string;
};

export type CourierOpenResult = {
  ok: boolean;
  reason?: string;
  detail?: string;
  job_id?: string;
  state?: string;
  environment?: string;
};

/** Is a courier service actually connected for this workspace? */
export function useCourierConnected() {
  return useQuery({
    queryKey: ["courier-connection"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("integration_connections")
        .select("enabled, status, environment")
        .eq("provider_code", "courier_gateway")
        .limit(1)
        .maybeSingle();
      if (error) return { connected: false, environment: null as string | null };
      const row = data as { enabled?: boolean; status?: string; environment?: string | null } | null;
      return {
        connected: Boolean(row?.enabled) && row?.status === "connected",
        environment: row?.environment ?? null,
      };
    },
    staleTime: 60_000,
  });
}

/** Every courier job raised for the given orders, newest first. */
export function useCourierJobs(orderIds: string[]) {
  const key = [...orderIds].sort().join(",");
  return useQuery({
    queryKey: ["courier-jobs", key],
    enabled: orderIds.length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("delivery_dispatch_jobs")
        .select("id, delivery_order_id, state, state_detail, provider_reference, environment, requested_at")
        .in("delivery_order_id", orderIds)
        .order("requested_at", { ascending: false });
      if (error) throw new Error(error.message);
      const byOrder = new Map<string, CourierJob>();
      for (const row of (data ?? []) as CourierJob[]) {
        if (!byOrder.has(row.delivery_order_id)) byOrder.set(row.delivery_order_id, row);
      }
      return byOrder;
    },
  });
}

/**
 * Opens a job and sends it in one step, because an unsent job helps nobody.
 * Every failure is reported with the courier's or the configuration's own reason.
 */
export function useSendToCourier() {
  const send = useServerFn(dispatchCourierJob);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { orderId: string }): Promise<CourierDispatchResult> => {
      const { data, error } = await guardedRpc(supabase, "neo_delivery_dispatch_open", {
        _order: input.orderId,
      });
      if (error) throw new Error(error.message);
      const opened = (data ?? { ok: false }) as CourierOpenResult;
      if (!opened.ok || !opened.job_id) {
        throw new Error(opened.detail ?? opened.reason ?? "The courier request could not be opened.");
      }
      return await send({ data: { jobId: opened.job_id } });
    },
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(
          result.state === "sent"
            ? "Sent to the courier. The order moves when they answer."
            : `Courier answered: ${result.state ?? "sent"}`,
        );
      } else {
        toast.error(result.detail ?? "The courier could not be asked.");
      }
      void qc.invalidateQueries({ queryKey: ["courier-jobs"] });
      void qc.invalidateQueries({ queryKey: ["delivery"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
