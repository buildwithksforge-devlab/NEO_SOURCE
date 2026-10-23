/**
 * Pre-arrival deposits.
 *
 * A deposit is a liability held against a reservation, not revenue, and it is
 * the gate the arrivals desk must pass before a stay may open. Nothing here
 * computes the position: `neo_reservation_deposit_position` is the single
 * source of truth, and the same rule is enforced again by the database trigger
 * on stays, so a refresh, a reopen or a direct call can never bypass it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { stableIdempotencyKey } from "@/lib/transaction-scope";


/* eslint-disable @typescript-eslint/no-explicit-any */
const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase as any).rpc(fn, args) as Promise<{ data: any; error: { message: string } | null }>;

export type DepositPosition = {
  ok: boolean;
  reason?: string;
  reservation_id?: string;
  currency?: string;
  required?: number;
  held?: number;
  applied?: number;
  paid?: number;
  outstanding?: number;
  waiver?: string | null;
  override_id?: string | null;
  may_check_in?: boolean;
  required_source?: "manual" | "policy" | "none" | string | null;
  policy_id?: string | null;
  policy_name?: string | null;
  policy_reason?: string | null;
  policy_amount?: number | null;
};

/** Why check-in is or is not permitted, in the words the desk should read. */
export function depositGate(position: DepositPosition | undefined | null): {
  blocked: boolean;
  message: string;
} {
  if (!position || !position.ok) {
    return { blocked: false, message: "Deposit position unavailable." };
  }
  if (position.waiver === "corporate-credit") {
    return { blocked: false, message: "Charged to a corporate credit account — no deposit due." };
  }
  if (position.override_id) {
    return {
      blocked: false,
      message: "An authorised override is on file for this arrival. It is used once.",
    };
  }
  const outstanding = Number(position.outstanding ?? 0);
  if (outstanding > 0.009) {
    return {
      blocked: true,
      message: `Deposit outstanding: ${outstanding.toFixed(2)} of ${Number(position.required ?? 0).toFixed(2)} required. Record the deposit or obtain an authorised override.`,
    };
  }
  return { blocked: false, message: "Deposit settled." };
}

export function useDepositPosition(reservationId: string | null | undefined, enabled = true) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "deposit-position", organizationId, reservationId],
    enabled: enabled && Boolean(organizationId) && Boolean(reservationId),
    queryFn: async (): Promise<DepositPosition> => {
      const { data, error } = await rpc("neo_reservation_deposit_position", {
        _reservation: reservationId,
      });
      if (error) throw new Error(error.message);
      return (data ?? { ok: false }) as DepositPosition;
    },
  });
}

function useInvalidateDeposits() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["pms"] });
    void qc.invalidateQueries({ queryKey: ["finance"] });
  };
}

/**
 * Records a received deposit. The idempotency key is minted per submission, so
 * a double-click, a retry or a refreshed request returns the first deposit
 * instead of taking the guest's money twice.
 */
export function useRecordDeposit() {
  const invalidate = useInvalidateDeposits();
  return useMutation({
    mutationFn: async (input: {
      reservationId: string;
      amount: number;
      method: string;
      reference?: string;
      notes?: string;
      idempotencyKey: string;
    }) => {
      const { data, error } = await rpc("neo_reservation_deposit_record", {
        _reservation: input.reservationId,
        _amount: input.amount,
        _method: input.method,
        _reference: input.reference ?? null,
        _idempotency_key: input.idempotencyKey,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
       const result = (data ?? {}) as {
         deposit_id?: string;
         idempotent?: boolean;
         position?: DepositPosition;
         finance?: { ok?: boolean; reason?: string; detail?: string };
       };
       if (!result.deposit_id) throw new Error("The deposit was not persisted.");
       return result;
    },
    onSuccess: (r) => {
      if (r.finance?.ok) {
        toast.success(r.idempotent ? "Deposit already recorded and posted" : "Deposit recorded and posted to Finance");
      } else {
        toast.warning(`Deposit recorded — Finance ${r.finance?.reason ?? "posting is pending"}`);
      }
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Authorised, single-use permission to check in with a deposit still outstanding. */
export function useDepositOverride() {
  const invalidate = useInvalidateDeposits();
  return useMutation({
    mutationFn: async (input: { reservationId: string; reason: string; authority: string }) => {
      const { data, error } = await rpc("neo_checkin_deposit_override", {
        _reservation: input.reservationId,
        _reason: input.reason,
        _authority: input.authority,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      toast.success("Override authorised for this arrival");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * One posting intent per source event and property.
 *
 * A key minted at random per submission made every retry — and every second
 * operator confirming the same money — a *new* deposit, which is how one
 * reservation came to sit twice in the Finance posting queue. The key is now
 * derived from the facts of the intent itself (property, reservation, amount,
 * method, reference, business date), so repeating the same intent returns the
 * existing deposit while a genuinely different one still records.
 */
export const depositIdempotencyKey = (input: {
  reservationId: string;
  propertyId: string | null;
  amount: number;
  method: string;
  reference?: string;
  businessDate?: string;
}) =>
  stableIdempotencyKey("deposit", "record", [
    input.propertyId,
    input.reservationId,
    input.amount.toFixed(2),
    input.method,
    input.reference ?? "",
    input.businessDate ?? new Date().toISOString().slice(0, 10),
  ]);

