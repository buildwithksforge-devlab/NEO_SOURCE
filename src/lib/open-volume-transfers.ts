import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export type OpenVolumeTransfer = {
  id: string;
  stock_item_id: string;
  item_name: string;
  from_location_id: string;
  to_location_id: string;
  source_name: string;
  destination_name: string;
  volume_ml: number;
  container_count: number;
  inventory_value: number | null;
  status: "in-transit" | "received" | "cancelled";
  reason: string;
  dispatched_at: string;
};

export type OpenVolumeDispatchInput = {
  stockItemId: string;
  fromLocationId: string;
  toLocationId: string;
  volumeMl: number;
  containerCount: number;
  attempt: string;
  reason: string;
};

export function verifyOpenVolumeTransferResult(
  data: unknown,
  expectedId?: string,
  expectedStatus?: string,
) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Transfer confirmation was not received.");
  }

  const result = data as Record<string, unknown>;

  if (
    result["ok"] !== true ||
    typeof result["transfer_id"] !== "string" ||
    !["in-transit", "received", "cancelled"].includes(
      String(result["status"]),
    )
  ) {
    throw new Error("Transfer transaction was not confirmed.");
  }

  if (expectedId && result["transfer_id"] !== expectedId) {
    throw new Error("A different transfer was returned.");
  }

  if (expectedStatus && result["status"] !== expectedStatus) {
    throw new Error("The saved transfer state differs from the requested action.");
  }

  return result;
}

export function validateOpenVolumeDispatch(input: OpenVolumeDispatchInput) {
  if (
    !input.stockItemId ||
    !input.fromLocationId ||
    !input.toLocationId ||
    !input.attempt
  ) {
    throw new Error("Complete all transfer details.");
  }

  if (input.fromLocationId === input.toLocationId) {
    throw new Error("Choose a different destination store.");
  }

  if (!Number.isFinite(input.volumeMl) || input.volumeMl <= 0) {
    throw new Error("Enter a positive measured volume.");
  }

  if (
    !Number.isSafeInteger(input.containerCount) ||
    input.containerCount <= 0
  ) {
    throw new Error("Enter the number of physical opened containers.");
  }

  if (input.reason.trim().length < 3) {
    throw new Error("Enter a transfer reason.");
  }
}

function useTransferScope() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return { organizationId, branchId };
}

function useRefreshTransferViews() {
  const qc = useQueryClient();

  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["inventory"] }),
      qc.invalidateQueries({ queryKey: ["stock-transfers"] }),
      qc.invalidateQueries({ queryKey: ["stores-department"] }),
      qc.invalidateQueries({ queryKey: ["finance"] }),
    ]);
}

export function useOpenVolumeTransfers(enabled = true) {
  const { organizationId, branchId } = useTransferScope();

  return useQuery({
    queryKey: ["inventory", "open-volume-transfers", organizationId, branchId],
    enabled: enabled && Boolean(organizationId && branchId),
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(
        supabase,
        "neo_open_volume_transfer_list",
        { _branch: branchId } as never,
      );

      if (error) throw new Error(error.message);

      if (!Array.isArray(data)) {
        throw new Error("Transfer register could not be verified.");
      }

      return data as unknown as OpenVolumeTransfer[];
    },
  });
}

export function useDispatchOpenVolumeTransfer() {
  const { organizationId, branchId } = useTransferScope();
  const refresh = useRefreshTransferViews();

  return useMutation({
    mutationFn: async (input: OpenVolumeDispatchInput) => {
      if (!organizationId || !branchId) {
        throw new Error("Select a property before dispatching stock.");
      }

      validateOpenVolumeDispatch(input);

      const { data, error } = await guardedRpc(
        supabase,
        "neo_open_volume_transfer_dispatch",
        {
          _branch: branchId,
          _item: input.stockItemId,
          _from: input.fromLocationId,
          _to: input.toLocationId,
          _ml: input.volumeMl,
          _containers: input.containerCount,
          _attempt: input.attempt,
          _reason: input.reason.trim(),
        } as never,
      );

      if (error) throw new Error(error.message);

      return verifyOpenVolumeTransferResult(data);
    },
    onSuccess: (result) => {
      toast.success(
        result["status"] === "in-transit"
          ? "Open stock dispatched. Awaiting receipt."
          : "Existing transfer confirmed.",
      );
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: refresh,
  });
}

export function useFinishOpenVolumeTransfer() {
  const refresh = useRefreshTransferViews();

  return useMutation({
    mutationFn: async (input: {
      transferId: string;
      action: "receive" | "cancel";
      reason?: string;
    }) => {
      if (
        input.action === "cancel" &&
        (input.reason?.trim().length ?? 0) < 3
      ) {
        throw new Error("Enter a cancellation reason.");
      }

      const { data, error } = await guardedRpc(
        supabase,
        "neo_open_volume_transfer_finish",
        {
          _transfer: input.transferId,
          _action: input.action,
          _reason: input.reason?.trim() || null,
        } as never,
      );

      if (error) throw new Error(error.message);

      return verifyOpenVolumeTransferResult(
        data,
        input.transferId,
        input.action === "receive" ? "received" : "cancelled",
      );
    },
    onSuccess: (result) => {
      toast.success(
        result["status"] === "received"
          ? "Destination receipt confirmed."
          : "Transfer cancelled. Source balance restored.",
      );
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: refresh,
  });
}