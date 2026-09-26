/**
 * The one canonical money projection.
 *
 * Two questions have to have one answer everywhere in NEØ:
 *
 *  1. What does this guest bill actually amount to — net, tax, gross, what has
 *     been collected, and what is still owed?
 *  2. How far has a payment travelled — requested, received, or recognised in
 *     the ledger?
 *
 * Both are answered by the database, once: `neo_folio_projection` for the bill
 * and `neo_payment_lifecycle` for the journey. The ledger stage is derived from
 * the posted journal itself, never from a status word typed by a module, so a
 * receipt cannot claim to be "in the ledger" without a journal that proves it.
 *
 * Folio, Payment Register, Transaction Register, Cashbook and the General
 * Ledger all read from here so they cannot disagree.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";

export type FolioProjection = {
  found: boolean;
  folioId: string | null;
  folioNumber: string | null;
  status: string | null;
  currency: string;
  branchId: string | null;
  reservationId: string | null;
  reservationNumber: string | null;
  customerId: string | null;
  guestName: string | null;
  netRevenue: number;
  tax: number;
  serviceCharge: number;
  grossObligation: number;
  collected: number;
  outstanding: number;
};

export type LedgerLine = {
  account_code: string | null;
  account_name: string | null;
  debit: number;
  credit: number;
  description?: string | null;
};

export type PaymentLifecycleStage = "pending" | "received" | "in_ledger" | "unsuccessful";

export type PaymentLifecycleRow = {
  paymentId: string;
  receiptNumber: string | null;
  branchId: string | null;
  folioId: string | null;
  folioNumber: string | null;
  reservationId: string | null;
  customerId: string | null;
  guestName: string | null;
  amount: number;
  currency: string;
  method: string | null;
  paidAt: string | null;
  journalId: string | null;
  journalNumber: string | null;
  journalStatus: string | null;
  accountingDate: string | null;
  stage: PaymentLifecycleStage;
  stageLabel: string;
  actorId: string | null;
  actorName: string | null;
  glLines: LedgerLine[];
};

const num = (v: unknown) => Number(v ?? 0);

export function mapFolioProjection(raw: Record<string, unknown> | null): FolioProjection {
  const r = raw ?? {};
  return {
    found: r["found"] === true,
    folioId: (r["folio_id"] as string) ?? null,
    folioNumber: (r["folio_number"] as string) ?? null,
    status: (r["status"] as string) ?? null,
    currency: String(r["currency"] ?? "KES"),
    branchId: (r["branch_id"] as string) ?? null,
    reservationId: (r["reservation_id"] as string) ?? null,
    reservationNumber: (r["reservation_number"] as string) ?? null,
    customerId: (r["customer_id"] as string) ?? null,
    guestName: (r["guest_name"] as string) ?? null,
    netRevenue: num(r["net_revenue"]),
    tax: num(r["tax"]),
    serviceCharge: num(r["service_charge"]),
    grossObligation: num(r["gross_obligation"]),
    collected: num(r["collected"]),
    outstanding: num(r["outstanding"]),
  };
}

export function mapPaymentLifecycle(r: Record<string, unknown>): PaymentLifecycleRow {
  return {
    paymentId: String(r["payment_id"] ?? ""),
    receiptNumber: (r["receipt_number"] as string) ?? null,
    branchId: (r["branch_id"] as string) ?? null,
    folioId: (r["folio_id"] as string) ?? null,
    folioNumber: (r["folio_number"] as string) ?? null,
    reservationId: (r["reservation_id"] as string) ?? null,
    customerId: (r["customer_id"] as string) ?? null,
    guestName: (r["guest_name"] as string) ?? null,
    amount: num(r["amount"]),
    currency: String(r["currency"] ?? "KES"),
    method: (r["method"] as string) ?? null,
    paidAt: (r["paid_at"] as string) ?? null,
    journalId: (r["journal_id"] as string) ?? null,
    journalNumber: (r["journal_number"] as string) ?? null,
    journalStatus: (r["journal_status"] as string) ?? null,
    accountingDate: (r["accounting_date"] as string) ?? null,
    stage: (String(r["stage"] ?? "pending") as PaymentLifecycleStage),
    stageLabel: String(r["stage_label"] ?? "Awaiting confirmation"),
    actorId: (r["actor_id"] as string) ?? null,
    actorName: (r["actor_name"] as string) ?? null,
    glLines: ((r["gl_lines"] ?? []) as Record<string, unknown>[]).map((l) => ({
      account_code: (l["account_code"] as string) ?? null,
      account_name: (l["account_name"] as string) ?? null,
      debit: num(l["debit"]),
      credit: num(l["credit"]),
      description: (l["description"] as string) ?? null,
    })),
  };
}

/* ------------------------------ invariants ------------------------------ */

/** gross = net + tax, to the cent. */
export function balancesGross(p: {
  netRevenue: number;
  tax: number;
  grossObligation: number;
}): boolean {
  return Math.abs(p.netRevenue + p.tax - p.grossObligation) < 0.01;
}

/** paid + outstanding = gross. */
export function balancesSettlement(p: {
  collected: number;
  outstanding: number;
  grossObligation: number;
}): boolean {
  return Math.abs(p.collected + p.outstanding - p.grossObligation) < 0.01;
}

/** A posted payment journal means the money is recognised — no other reading. */
export function stageFromJournal(input: {
  journalId: string | null;
  journalStatus: string | null;
  paymentStatus?: string | null;
}): PaymentLifecycleStage {
  if (input.journalId && input.journalStatus === "posted") return "in_ledger";
  const s = input.paymentStatus ?? "";
  if (s === "confirmed" || s === "completed") return "received";
  if (s === "failed" || s === "cancelled" || s === "voided") return "unsuccessful";
  return "pending";
}

/** A journal detail view must show exactly the lines the ledger holds. */
export function detailMatchesLedger(detail: LedgerLine[], ledger: LedgerLine[]): boolean {
  const key = (l: LedgerLine) => `${l.account_code ?? ""}|${l.debit}|${l.credit}`;
  const a = detail.map(key).sort();
  const b = ledger.map(key).sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export const STAGE_LABEL: Record<PaymentLifecycleStage, string> = {
  pending: "Awaiting confirmation",
  received: "Money received",
  in_ledger: "In the ledger",
  unsuccessful: "Unsuccessful",
};

/* -------------------------------- hooks -------------------------------- */

export function useFolioProjection(folioId: string | null | undefined) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["folio-projection", organizationId, folioId ?? null],
    enabled: Boolean(organizationId && folioId),
    queryFn: async (): Promise<FolioProjection> => {
      const { data, error } = await guardedRpc(supabase, "neo_folio_projection", {
        _folio: folioId,
      });
      if (error) throw new Error(error.message);
      return mapFolioProjection((data ?? null) as Record<string, unknown> | null);
    },
  });
}

export function usePaymentLifecycle(scope: {
  branchId?: string | null;
  from?: string | null;
  to?: string | null;
  paymentId?: string | null;
}) {
  const { organizationId } = useAuth();
  const branch = scope.branchId && scope.branchId !== "all" ? scope.branchId : null;
  return useQuery({
    queryKey: [
      "payment-lifecycle",
      organizationId,
      branch,
      scope.from ?? null,
      scope.to ?? null,
      scope.paymentId ?? null,
    ],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<PaymentLifecycleRow[]> => {
      const { data, error } = await guardedRpc(supabase, "neo_payment_lifecycle", {
        _branch: branch,
        _from: scope.from ?? null,
        _to: scope.to ?? null,
        _payment: scope.paymentId ?? null,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Record<string, unknown>[]).map(mapPaymentLifecycle);
    },
  });
}

export type PaymentAuditTrail = {
  found: boolean;
  reference: string | null;
  recordId: string | null;
  amount: number;
  recordedAt: string | null;
  actorId: string | null;
  actorName: string | null;
  journalId: string | null;
  financialConsequence: LedgerLine[];
  events: Array<{
    id: string;
    at: string;
    action: string;
    module: string | null;
    actorId: string | null;
    actorName: string | null;
    reason: string | null;
  }>;
};

export function usePaymentAuditTrail(paymentId: string | null | undefined) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["payment-audit-trail", organizationId, paymentId ?? null],
    enabled: Boolean(organizationId && paymentId),
    queryFn: async (): Promise<PaymentAuditTrail> => {
      const { data, error } = await guardedRpc(supabase, "neo_payment_audit_trail", {
        _payment: paymentId,
      });
      if (error) throw new Error(error.message);
      const r = (data ?? {}) as Record<string, unknown>;
      return {
        found: r["found"] === true,
        reference: (r["reference"] as string) ?? null,
        recordId: (r["record_id"] as string) ?? null,
        amount: num(r["amount"]),
        recordedAt: (r["recorded_at"] as string) ?? null,
        actorId: (r["captured_actor_id"] as string) ?? null,
        // An actor is shown only when a source proves it; never invented.
        actorName: (r["captured_actor_name"] as string) ?? null,
        journalId: (r["journal_id"] as string) ?? null,
        financialConsequence: ((r["financial_consequence"] ?? []) as Record<string, unknown>[]).map(
          (l) => ({
            account_code: (l["account_code"] as string) ?? null,
            account_name: (l["account_name"] as string) ?? null,
            debit: num(l["debit"]),
            credit: num(l["credit"]),
          }),
        ),
        events: ((r["events"] ?? []) as Record<string, unknown>[]).map((e) => ({
          id: String(e["id"] ?? ""),
          at: String(e["at"] ?? ""),
          action: String(e["action"] ?? ""),
          module: (e["module"] as string) ?? null,
          actorId: (e["actor_id"] as string) ?? null,
          actorName: (e["actor_name"] as string) ?? null,
          reason: (e["reason"] as string) ?? null,
        })),
      };
    },
  });
}
