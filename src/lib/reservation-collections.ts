import { guardedRpc } from "@/lib/rpc-guard";
import { invalidatePaymentViews } from "@/lib/payment-view-refresh";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { readViewAccess, VISIBLE_VIEW_REFRESH } from "@/lib/view-freshness";
export type CollectionSource = {
  id: string;
  amount: number | string;
  currency: string;
  method: string;
  status: string;
  payment_id?: string | null;
  reference?: string | null;
  receipt_number?: string | null;
  received_at?: string | null;
  paid_at?: string | null;
};
export type ReservationCollection = {
  id: string;
  kind: "deposit" | "payment";
  amount: number;
  currency: string;
  method: string;
  state: string;
  reference: string | null;
  receivedAt: string | null;
};
const received = new Set(["confirmed", "completed", "posted", "paid", "settled"]);
/** Presentation of saved collections only. Deposit application is never another receipt. */
export function reservationCollections(
  deposits: CollectionSource[],
  payments: CollectionSource[],
): ReservationCollection[] {
  const saved = new Map<string, CollectionSource>();
  for (const p of payments) {
    const old = saved.get(p.id);
    if (
      old &&
      (Number(old.amount) !== Number(p.amount) ||
        old.currency !== p.currency ||
        old.status !== p.status)
    )
      throw new Error("Payment evidence disagrees. Refresh before using these collections.");
    saved.set(p.id, p);
  }
  const covered = new Set<string>();
  const make = (
    row: CollectionSource,
    kind: "deposit" | "payment",
    state: string,
  ): ReservationCollection => {
    const amount = Number(row.amount);
    if (!row.id || !Number.isFinite(amount) || amount <= 0 || !row.currency)
      throw new Error("Collection amounts could not be verified.");
    return {
      id: kind + ":" + row.id,
      kind,
      amount,
      currency: row.currency,
      method: row.method,
      state,
      reference: row.receipt_number ?? row.reference ?? null,
      receivedAt: row.received_at ?? row.paid_at ?? null,
    };
  };
  const rows = deposits.map((d) => {
    const linked = d.payment_id ? saved.get(d.payment_id) : undefined;
    if (linked) {
      if (Number(linked.amount) !== Number(d.amount) || linked.currency !== d.currency)
        throw new Error(
          "Deposit and linked payment amounts or currency disagree. Review before collecting again.",
        );
      covered.add(linked.id);
    }
    const state = ["held", "applied", "forfeited"].includes(d.status)
      ? linked && !received.has(linked.status)
        ? "Review linked payment"
        : "Received"
      : d.status === "refunded"
        ? "Refunded"
        : ["cancelled", "voided", "void"].includes(d.status)
          ? "Cancelled"
          : "Awaiting confirmation";
    return make(d, "deposit", state);
  });
  for (const p of saved.values())
    if (!covered.has(p.id))
      rows.push(
        make(
          p,
          "payment",
          received.has(p.status)
            ? "Received"
            : ["pending", "processing", "submitted", "initiated"].includes(p.status)
              ? "Awaiting confirmation"
              : ["refunded", "reversed"].includes(p.status)
                ? "Refunded"
                : ["cancelled", "void", "voided", "failed"].includes(p.status)
                  ? "Unsuccessful"
                  : "Review status",
        ),
      );
  return rows.sort(
    (a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? "") || a.id.localeCompare(b.id),
  );
}
export function useReservationCollections(reservationId: string, folioIds: string[]) {
  const auth = useAuth(),
    { identity, ready } = readViewAccess(auth);
  const ids = [...new Set(folioIds)].sort();
  // The generated table union is intentionally narrowed by the verified projection below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  return useQuery({
    queryKey: [
      "pms",
      "reservation-collections",
      auth.organizationId,
      identity,
      reservationId,
      ids.join(","),
    ],
    enabled: ready && Boolean(reservationId),
    ...VISIBLE_VIEW_REFRESH,
    queryFn: async () => {
      const columns = "id,amount,currency,method,status,receipt_number,paid_at";
      const [d, p, f] = await Promise.all([
        db
          .from("reservation_deposits")
          .select("id,amount,currency,method,status,payment_id,reference,received_at")
          .eq("organization_id", auth.organizationId)
          .eq("reservation_id", reservationId),
        db
          .from("payments")
          .select(columns)
          .eq("organization_id", auth.organizationId)
          .eq("reservation_id", reservationId),
        ids.length
          ? db
              .from("payments")
              .select(columns)
              .eq("organization_id", auth.organizationId)
              .in("folio_id", ids)
          : Promise.resolve({ data: [], error: null }),
      ]);
      for (const result of [d, p, f]) if (result.error) throw new Error(result.error.message);
      if (!Array.isArray(d.data) || !Array.isArray(p.data) || !Array.isArray(f.data))
        throw new Error("Collection history could not be verified.");
      return reservationCollections(d.data, [...p.data, ...f.data]);
    },
  });
}

export type ReservationCollectionPosition = {
  currency: string;
  quote: number;
  obligation: number;
  collected: number;
  pending: number;
  outstanding: number;
  credit: number;
  headroom: number;
  payment_status: string;
  deposit_paid: number;
};
export function useReservationCollectionPosition(reservationId: string) {
  const auth = useAuth(),
    { identity, ready } = readViewAccess(auth);
  return useQuery({
    queryKey: [
      "pms",
      "reservation-collection-position",
      auth.organizationId,
      identity,
      reservationId,
    ],
    enabled: ready && Boolean(reservationId),
    ...VISIBLE_VIEW_REFRESH,
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_reservation_collection_position", {
        _reservation: reservationId,
      });
      if (error) throw error;
      if (
        !data ||
        data.reservation_id !== reservationId ||
        typeof data.currency !== "string" ||
        !["unpaid", "part-paid", "paid"].includes(data.payment_status)
      )
        throw new Error("Reservation collection position could not be verified.");
      for (const key of [
        "quote",
        "obligation",
        "collected",
        "pending",
        "outstanding",
        "credit",
        "headroom",
        "deposit_paid",
      ])
        if (typeof data[key] !== "number" || !Number.isFinite(data[key]) || data[key] < 0)
          throw new Error("Reservation amounts could not be verified.");
      return data as ReservationCollectionPosition;
    },
  });
}
export function useConfirmReservationPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; reference: string; note: string }) => {
      const { data, error } = await guardedRpc(supabase, "pms_confirm_payment", {
        _payment: input.id,
        _reference: input.reference.trim() || null,
        _note: input.note.trim() || null,
      });
      if (error) throw error;
      if (!data || data.ok !== true || data.payment_id !== input.id)
        throw new Error(
          data?.detail ?? data?.reason ?? "Payment confirmation could not be verified.",
        );
      return data;
    },
    onSuccess: async () => {
      await invalidatePaymentViews(qc);
      toast.success("Payment confirmed.");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
