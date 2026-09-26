/**
 * Store transfers — a first-class inventory transaction.
 *
 * A transfer is not "usage without sale". It moves stock between two stores of
 * the same property: the source is deducted when the transfer is created (the
 * stock is in transit), the destination is credited only when someone at the
 * receiving store confirms arrival. Property total stock is unchanged.
 *
 * Every submission carries one attempt key, so a repeated click replays the
 * original transfer instead of moving stock twice. All validation — same-store,
 * positive quantity, property-valid items, sufficient source stock — lives in
 * the database routine, never in this file.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

// The transfer trail spans several generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type TransferRow = Record<string, unknown>;

export type TransferLineInput = { stock_item_id: string; quantity: number; unit?: string };

/** One key per user submission, not per attempt — retries must reuse it. */
export function newTransferAttemptKey(): string {
  return crypto.randomUUID();
}

export const OPEN_TRANSFER_STATUSES = ["draft", "pending", "in-transit"] as const;

function useTransferInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["inventory"] });
    void qc.invalidateQueries({ queryKey: ["stock-transfers"] });
    void qc.invalidateQueries({ queryKey: ["stores-department"] });
  };
}

export function useStoreTransfers(scope: "open" | "all" = "all") {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["stock-transfers", "list", organizationId, branchId, scope],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("stock_transfers")
        .select(
          "id, transfer_number, status, reason, notes, created_at, dispatched_at, received_at, cancelled_at, from_location_id, to_location_id, from_store:stock_locations!stock_transfers_from_location_id_fkey(name), to_store:stock_locations!stock_transfers_to_location_id_fkey(name), stock_transfer_lines(id, quantity, received_quantity, unit, stock_item_id, stock_items(name, base_unit))",
        )
        .order("created_at", { ascending: false })
        .limit(100);
      if (branchId) q = q.eq("branch_id", branchId);
      if (scope === "open") q = q.in("status", OPEN_TRANSFER_STATUSES as unknown as string[]);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as TransferRow[];
    },
  });
}

export function useCreateTransfer() {
  const invalidate = useTransferInvalidate();
  const { branchId } = useActivePropertyFilter();
  return useMutation({
    mutationFn: async (input: {
      fromLocationId: string;
      toLocationId: string;
      lines: TransferLineInput[];
      reason: string;
      attemptKey: string;
      branchId?: string | null;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_stores_transfer_create", {
        _branch: input.branchId ?? branchId ?? null,
        _from: input.fromLocationId,
        _to: input.toLocationId,
        _lines: input.lines,
        _reason: input.reason,
        _attempt: input.attemptKey,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: (data) => {
      invalidate();
      if (data["replayed"] === true)
        toast.info("Already recorded — showing the original transfer.");
      else
        toast.success(
          `Transfer ${String(data["transfer_number"] ?? "")} created — stock is in transit.`,
        );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReceiveTransfer() {
  const invalidate = useTransferInvalidate();
  return useMutation({
    mutationFn: async (transferId: string) => {
      const { data, error } = await guardedRpc(db, "neo_stores_transfer_receive", {
        _transfer: transferId,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: (data) => {
      invalidate();
      if (data["replayed"] === true) toast.info("This transfer was already received.");
      else toast.success("Transfer received into the destination store.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCancelTransfer() {
  const invalidate = useTransferInvalidate();
  return useMutation({
    mutationFn: async ({ transferId, reason }: { transferId: string; reason: string }) => {
      const { data, error } = await guardedRpc(db, "neo_stores_transfer_cancel", {
        _transfer: transferId,
        _reason: reason,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Transfer cancelled — the stock is back in the source store.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
