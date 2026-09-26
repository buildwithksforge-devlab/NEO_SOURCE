import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { logAudit } from "@/lib/audit";
import type { Row } from "@/lib/finance";

// The finance schema is broad; the generated types are narrowed per table at call sites.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Builder = any;

export function useFinanceCtx() {
  const { organizationId, profile, user } = useAuth();
  // The active property selection wins over the pinned home property so books
  // are written against the property the user is actually working in.
  const { branchId: activeBranchId } = useActivePropertyFilter();
  return {
    organizationId,
    branchId: activeBranchId ?? (profile as { branch_id?: string | null } | null)?.branch_id ?? null,
    userId: user?.id ?? null,
    userName: (profile as { full_name?: string } | null)?.full_name ?? "",
  };
}

function useList(key: string, table: string, select: string, build?: (q: Builder) => Builder, deps: unknown[] = []) {
  const { organizationId } = useFinanceCtx();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["finance", key, organizationId, filterKey, ...deps],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q: Builder = applyTo(db.from(table).select(select), table);
      if (build) q = build(q);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

/**
 * The finance page reads the canonical fact layer for the current month in the
 * property-local sense, scoped to the active property selection. Analytics and
 * the dashboards pass the same shape, so the shared figures match.
 */
export function useFinanceFactScope() {
  const { branchId } = useFinanceCtx();
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    branchId,
    from: iso(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: iso(now),
  };
}

/* ------------------------------- metrics ------------------------------- */

export function useFinanceMetrics(branchId: string | null = null, from?: string, to?: string) {
  const { organizationId } = useFinanceCtx();
  return useQuery({
    queryKey: ["finance", "metrics", organizationId, branchId, from, to],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "fin_metrics", {
        _branch: branchId,
        _from: from ?? null,
        _to: to ?? null,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
  });
}

export function useTrialBalance(from: string, to: string, branchId: string | null = null) {
  const { organizationId } = useFinanceCtx();
  return useQuery({
    queryKey: ["finance", "trial-balance", organizationId, from, to, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "fin_trial_balance", { _from: from, _to: to, _branch: branchId });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

/* -------------------------------- reads -------------------------------- */

export const useAccounts = () =>
  useList("accounts", "chart_of_accounts", "*", (q) => q.order("code"));

export const useTaxCodes = () => useList("tax-codes", "tax_codes", "*", (q) => q.order("code"));

export const useAccountMappings = () =>
  useList("mappings", "account_mappings", "*", (q) => q.order("source_module").order("event_key"));

export const useFinancialYears = () =>
  useList("years", "financial_years", "*", (q) => q.order("starts_on", { ascending: false }));

export const useAccountingPeriods = () =>
  useList("periods", "accounting_periods", "*", (q) => q.order("starts_on"));

export const useJournals = (status: string) =>
  useList(
    "journals",
    "journal_entries",
    "*",
    (q) => {
      let b = q.order("created_at", { ascending: false }).limit(200);
      if (status !== "all") b = b.eq("status", status);
      return b;
    },
    [status],
  );

/**
 * Journal detail is read by canonical journal id through one property-scoped
 * routine, so the detail view always shows exactly the lines the general
 * ledger already proves exist for that journal.
 */
export const useJournal = (id: string | null) => {
  const { organizationId } = useFinanceCtx();
  const { filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["finance", "journal", organizationId, filterKey, id],
    enabled: Boolean(organizationId && id),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_journal_detail", { _journal: id });
      if (error) throw error;
      const detail = (data ?? null) as Record<string, unknown> | null;
      if (!detail || detail["found"] !== true) return null;
      const lines = ((detail["lines"] ?? []) as Record<string, unknown>[]).map((l, index) => ({
        ...l,
        line_number: index + 1,
        chart_of_accounts: { code: l["account_code"], name: l["account_name"] },
      }));
      return { ...detail, journal_entry_lines: lines } as unknown as Row;
    },
  });
};

export const useInvoices = (status: string) =>
  useList(
    "invoices",
    "invoices",
    "*, customers(full_name), corporate_accounts(legal_name)",
    (q) => {
      let b = q.order("issue_date", { ascending: false }).limit(300);
      if (status !== "all") b = b.eq("status", status);
      return b;
    },
    [status],
  );

export const useCreditNotes = () =>
  useList("credit-notes", "credit_notes", "*, customers(full_name)", (q) =>
    q.order("issue_date", { ascending: false }).limit(200),
  );

export const useCreditApplications = () =>
  useList("credit-applications", "corporate_credit_applications", "*, corporate_accounts(legal_name)", (q) =>
    q.order("created_at", { ascending: false }),
  );

export const useCollectionNotes = () =>
  useList("collection-notes", "collection_notes", "*, corporate_accounts(legal_name), customers(full_name)", (q) =>
    q.order("created_at", { ascending: false }).limit(200),
  );

export const useStatements = () =>
  useList("statements", "customer_statements", "*, corporate_accounts(legal_name), customers(full_name)", (q) =>
    q.order("period_end", { ascending: false }).limit(200),
  );

export const useSupplierInvoices = () =>
  useList("supplier-invoices", "supplier_invoices", "*, suppliers(name)", (q) =>
    q.order("invoice_date", { ascending: false }).limit(300),
  );

export const useSupplierPayments = () =>
  useList("supplier-payments", "supplier_payments", "*, suppliers(name)", (q) =>
    q.order("paid_on", { ascending: false }).limit(200),
  );

/**
 * The supplier payment conveyor.
 *
 * Scheduling a payment is not paying it. A payment travels
 * Scheduled → Awaiting approval → Approved → Released → Paid, and only the
 * settle step writes the journal that reduces what is owed and reduces the
 * bank. The database owns the rulebook, the self-approval bar and the posting
 * identity, so a double-click cannot pay a supplier twice.
 */
export type SupplierPaymentAction = "submit" | "approve" | "release" | "settle" | "fail";

export function useAdvanceSupplierPayment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      paymentId: string;
      action: SupplierPaymentAction;
      reason?: string | undefined;
    }) => {
      const { data, error } = await guardedRpc(supabase, "neo_supplier_payment_advance", {
        _payment: input.paymentId,
        _action: input.action,
        _reason: input.reason ?? null,
      } as never);
      if (error) throw error;
      return (data ?? {}) as {
        ok?: boolean;
        idempotent?: boolean;
        status?: string;
        journal_id?: string | null;
        detail?: string;
      };
    },
    onSuccess: (r) => {
      if (r.ok === false) toast.error(r.detail ?? "The payment could not be settled.");
      else if (r.idempotent) toast.info(`Already ${r.status}.`);
      else if (r.status === "paid")
        toast.success(r.journal_id ? "Paid and posted to the ledger" : "Paid — posting is pending");
      else toast.success(`Payment ${r.status}`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Releasing a scheduled supplier payment.
 *
 * A schedule is only a plan. Releasing it is the controlled step that creates
 * the real payment record, and the database restricts that authority to a
 * finance approver or an owner and writes the audit evidence. The created
 * payment then continues through the conveyor to settlement and the journal.
 */
export function useReleasePaymentSchedule() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      scheduleId: string;
      reason?: string | undefined;
      /** The account the transfer actually leaves; required for bank transfers and cheques. */
      bankAccountId?: string | undefined;
      /** The bank's transfer or cheque reference, so the statement can confirm it. */
      reference?: string | undefined;
      paidOn?: string | undefined;
    }) => {
      const { data, error } = await guardedRpc(supabase, "neo_payment_schedule_release", {
        _schedule: input.scheduleId,
        _reason: input.reason ?? null,
        _bank_account: input.bankAccountId ?? null,
        _reference: input.reference ?? null,
        _paid_on: input.paidOn ?? null,
      } as never);
      if (error) throw error;
      return (data ?? {}) as {
        ok?: boolean;
        idempotent?: boolean;
        status?: string;
        payment_number?: string | null;
      };
    },
    onSuccess: (r) => {
      if (r.idempotent) toast.info("This schedule was already released.");
      else toast.success(`Released as ${r.payment_number ?? "a supplier payment"}`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


export const usePaymentSchedules = () =>
  useList("payment-schedules", "payment_schedules", "*, suppliers(name)", (q) => q.order("scheduled_date"));

export const useSuppliers = () => useList("suppliers", "suppliers", "id, name, active", (q) => q.order("name"));

export const usePayments = () =>
  useList("payments", "payments", "*, customers(full_name)", (q) =>
    q.order("paid_at", { ascending: false }).limit(300),
  );

export const useBankAccounts = () => useList("bank-accounts", "bank_accounts", "*", (q) => q.order("name"));

export const useStatementEntries = (bankAccountId: string | null) =>
  useList(
    "statement-entries",
    "bank_statement_entries",
    "*, bank_accounts(name, account_kind)",
    (q) => {
      let b = q.order("value_date", { ascending: false }).limit(300);
      if (bankAccountId) b = b.eq("bank_account_id", bankAccountId);
      return b;
    },
    [bankAccountId],
  );

export const useReconciliations = () =>
  useList("reconciliations", "reconciliations", "*, bank_accounts(name)", (q) =>
    q.order("period_end", { ascending: false }),
  );

export const useCashDrawers = () => useList("drawers", "cash_drawers", "*", (q) => q.order("name"));

export const useCashCounts = () =>
  useList("cash-counts", "cash_counts", "*, cash_drawers(name)", (q) =>
    q.order("created_at", { ascending: false }).limit(200),
  );

export const useCashTransfers = () =>
  useList("cash-transfers", "cash_transfers", "*, cash_drawers!cash_transfers_from_drawer_id_fkey(name)", (q) =>
    q.order("sent_at", { ascending: false }).limit(200),
  );

export const useCashierShifts = () =>
  useList("shifts", "pos_shifts", "*", (q) => q.order("opened_at", { ascending: false }).limit(100));

export const useOtaReceivables = () =>
  useList("ota", "ota_receivables", "*, ota_vcc_records(*)", (q) =>
    q.order("created_at", { ascending: false }).limit(200),
  );

export const useEtimsSubmissions = () =>
  useList("etims", "etims_submissions", "*", (q) => q.order("created_at", { ascending: false }).limit(200));

export const useTaxTransactions = () =>
  useList("tax-transactions", "tax_transactions", "*, tax_codes(code, name)", (q) =>
    q.order("transaction_date", { ascending: false }).limit(300),
  );

export const useExpenses = () =>
  useList("expenses", "expense_claims", "*, suppliers(name)", (q) =>
    q.order("expense_date", { ascending: false }).limit(200),
  );

export const useBudgets = () => useList("budgets", "budgets", "*, budget_lines(*)", (q) => q.order("created_at", { ascending: false }));

export const useFinancialAlerts = () =>
  useList("alerts", "financial_alerts", "*", (q) => q.order("created_at", { ascending: false }).limit(100));

export const useCorporateAccounts = () =>
  useList("corporate", "corporate_accounts", "id, legal_name, account_number, account_status", (q) =>
    q.order("legal_name"),
  );

export const useFinanceFolios = () =>
  useList(
    "folios",
    "folios",
    "id, folio_number, folio_type, status, currency, total_charges, total_payments, balance, customers(full_name), corporate_accounts(legal_name)",
    (q) => q.order("opened_at", { ascending: false }).limit(200),
  );

/* ------------------------------ mutations ------------------------------ */

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["finance"] });
}

/** Generic org-scoped insert with audit logging. */
export function useFinanceInsert(table: string, action: string, options?: { branchScoped?: boolean }) {
  const ctx = useFinanceCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (values: Row) => {
      const payload: Row = {
        ...values,
        organization_id: ctx.organizationId,
        ...(options?.branchScoped !== false && ctx.branchId ? { branch_id: values["branch_id"] ?? ctx.branchId } : {}),
      };
      const { data, error } = await db.from(table).insert(payload).select().single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: async (data) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action,
        module: "finance",
        recordId: (data as Row)["id"] ?? null,
        newValue: data,
      });
      invalidate();
      toast.success("Saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useFinanceUpdate(table: string, action: string) {
  const ctx = useFinanceCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, values, reason }: { id: string; values: Row; reason?: string }) => {
      const { data, error } = await db.from(table).update(values).eq("id", id).select().single();
      if (error) throw error;
      return { data: data as Row, reason };
    },
    onSuccess: async ({ data, reason }) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action,
        module: "finance",
        recordId: (data as Row)["id"] ?? null,
        newValue: data,
        reason: reason ?? null,
      });
      invalidate();
      toast.success("Updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Seed the default chart of accounts, tax codes and periods for this organization. */
export function useSeedFinanceDefaults() {
  const ctx = useFinanceCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(db, "fin_seed_finance_defaults");
      if (error) throw error;
      return data as Row;
    },
    onSuccess: async (data) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "finance.seed_defaults",
        module: "finance",
        newValue: data,
      });
      invalidate();
      toast.success("Finance defaults ready");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Create a balanced draft journal with its lines. */
export function useCreateJournal() {
  const ctx = useFinanceCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: { header: Row; lines: Row[] }) => {
      const { data: number, error: numErr } = await guardedRpc(db, "next_document_number", { _doc_type: "journal" });
      if (numErr) throw numErr;
      const { data: journal, error } = await db
        .from("journal_entries")
        .insert({
          ...input.header,
          organization_id: ctx.organizationId,
          branch_id: input.header["branch_id"] ?? ctx.branchId,
          journal_number: number,
          created_by: ctx.userId,
          status: "draft",
          total_debit: input.lines.reduce((s, l) => s + Number(l["debit"] ?? 0), 0),
          total_credit: input.lines.reduce((s, l) => s + Number(l["credit"] ?? 0), 0),
        })
        .select()
        .single();
      if (error) throw error;
      const lines = input.lines.map((l, i) => ({
        ...l,
        organization_id: ctx.organizationId,
        journal_id: (journal as Row)["id"],
        line_number: i + 1,
      }));
      const { error: lineErr } = await db.from("journal_entry_lines").insert(lines);
      if (lineErr) throw lineErr;
      return journal as Row;
    },
    onSuccess: async (journal) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "finance.journal.created",
        module: "finance",
        recordId: (journal as Row)["id"] ?? null,
        newValue: journal,
      });
      invalidate();
      toast.success(`Journal ${(journal as Row)["journal_number"]} created as draft`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePostJournal() {
  const ctx = useFinanceCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (journalId: string) => {
      const { data, error } = await guardedRpc(db, "fin_post_journal", { _journal: journalId });
      if (error) throw error;
      return data as Row;
    },
    onSuccess: async (data) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "finance.journal.posted",
        module: "finance",
        recordId: (data as Row)?.["journal_id"] ?? null,
        newValue: data,
      });
      invalidate();
      toast.success("Journal posted to the ledger");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReverseJournal() {
  const ctx = useFinanceCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ journalId, reason }: { journalId: string; reason: string }) => {
      const { data, error } = await guardedRpc(db, "fin_reverse_journal", { _journal: journalId, _reason: reason });
      if (error) throw error;
      return { data: data as Row, reason };
    },
    onSuccess: async ({ data, reason }) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "finance.journal.reversed",
        module: "finance",
        recordId: (data as Row)?.["reversal_journal_id"] ?? null,
        newValue: data,
        reason,
      });
      invalidate();
      toast.success("Reversal journal posted");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Raise an approval request through the existing Phase 2 Approval Centre. */
export function useRequestFinanceApproval() {
  const ctx = useFinanceCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: { approvalType: string; reference: string; amount?: number; reason: string }) => {
      const { data, error } = await db
        .from("approval_requests")
        .insert({
          organization_id: ctx.organizationId,
          branch_id: ctx.branchId,
          approval_type: input.approvalType,
          reference: input.reference,
          requester_id: ctx.userId,
          reason: input.reason,
          amount: input.amount ?? null,
          status: "pending_approval",
        })
        .select()
        .single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: async (data) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "finance.approval.requested",
        module: "finance",
        recordId: (data as Row)["id"] ?? null,
        newValue: data,
      });
      invalidate();
      toast.success("Sent to the Approval Centre");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Finance workspace readiness — chart of accounts, tax codes, financial year,
 * accounting periods and payment methods must all exist before finance is
 * treated as operational.
 */
export function useFinanceReadiness() {
  const { organizationId } = useFinanceCtx();
  return useQuery({
    queryKey: ["finance", "readiness", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_finance_readiness");
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
  });
}

/* --------------------------- journal register ----------------------------- */

/**
 * The full journal register. Read through `neo_journal_register` rather than
 * the table so every row carries its period, source document, property,
 * preparer, poster, balance verdict and reversal relationship — the columns a
 * Finance reviewer needs to trust the ledger.
 */
export type JournalRegisterRow = {
  id: string;
  journal_number: string | null;
  accounting_date: string | null;
  period_name: string | null;
  period_status: string | null;
  journal_type: string | null;
  source_module: string | null;
  source_document_type: string | null;
  source_document_id: string | null;
  document_number: string | null;
  description: string | null;
  currency: string | null;
  total_debit: number;
  total_credit: number;
  balanced: boolean;
  line_count: number;
  status: string;
  branch_id: string | null;
  property: string | null;
  created_by_name: string | null;
  created_at: string | null;
  posted_by_name: string | null;
  posted_at: string | null;
  reverses_journal_id: string | null;
  reverses_journal_number: string | null;
  reversed_by_journal_id: string | null;
  reversed_by_journal_number: string | null;
};

export function useJournalRegister(status: string, module: string) {
  const { organizationId } = useFinanceCtx();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["finance", "journal-register", organizationId, branchId ?? null, status, module],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<JournalRegisterRow[]> => {
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const { data, error } = await (db as any).rpc("neo_journal_register", {
        _branch: branchId ?? null,
        _status: status === "all" ? null : status,
        _module: module === "all" ? null : module,
      });
      if (error) throw new Error(error.message);
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      return ((data ?? []) as any[]).map((r) => ({
        id: String(r.id),
        journal_number: r.journal_number ?? null,
        accounting_date: r.accounting_date ?? null,
        period_name: r.period_name ?? null,
        period_status: r.period_status ?? null,
        journal_type: r.journal_type ?? null,
        source_module: r.source_module ?? null,
        source_document_type: r.source_document_type ?? null,
        source_document_id: r.source_document_id ?? null,
        document_number: r.document_number ?? null,
        description: r.description ?? null,
        currency: r.currency ?? null,
        total_debit: Number(r.total_debit ?? 0),
        total_credit: Number(r.total_credit ?? 0),
        balanced: Boolean(r.balanced),
        line_count: Number(r.line_count ?? 0),
        status: String(r.status ?? "draft"),
        branch_id: r.branch_id ?? null,
        property: r.property ?? null,
        created_by_name: r.created_by_name ?? null,
        created_at: r.created_at ?? null,
        posted_by_name: r.posted_by_name ?? null,
        posted_at: r.posted_at ?? null,
        reverses_journal_id: r.reverses_journal_id ?? null,
        reverses_journal_number: r.reverses_journal_number ?? null,
        reversed_by_journal_id: r.reversed_by_journal_id ?? null,
        reversed_by_journal_number: r.reversed_by_journal_number ?? null,
      }));
    },
  });
}

/* ----------------------------- general ledger ----------------------------- */

/**
 * Every posted ledger line for a period, grouped by account. The running
 * balance and the opening balance come from `neo_general_ledger`, so the page
 * never re-computes a figure the ledger already owns.
 */
export type GeneralLedgerLine = {
  account_id: string;
  account_code: string;
  account_name: string;
  account_category: string | null;
  opening_balance: number;
  line_id: string;
  journal_id: string;
  journal_number: string | null;
  accounting_date: string | null;
  period_name: string | null;
  period_status: string | null;
  source_module: string | null;
  source_document_type: string | null;
  source_document_id: string | null;
  document_number: string | null;
  description: string | null;
  branch_id: string | null;
  property: string | null;
  debit: number;
  credit: number;
  running_balance: number;
};

export function useGeneralLedger(from: string, to: string, accountId: string | null = null) {
  const { organizationId } = useFinanceCtx();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["finance", "general-ledger", organizationId, branchId ?? "all", from, to, accountId],
    enabled: Boolean(organizationId) && Boolean(from) && Boolean(to),
    queryFn: async (): Promise<GeneralLedgerLine[]> => {
      const { data, error } = await guardedRpc(db, "neo_general_ledger", {
        _from: from,
        _to: to,
        _branch: branchId,
        _account: accountId,
      });
      if (error) throw new Error((error as { message: string }).message);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((data ?? []) as any[]).map((r) => ({
        account_id: String(r.account_id),
        account_code: String(r.account_code ?? ""),
        account_name: String(r.account_name ?? ""),
        account_category: r.account_category ?? null,
        opening_balance: Number(r.opening_balance ?? 0),
        line_id: String(r.line_id),
        journal_id: String(r.journal_id),
        journal_number: r.journal_number ?? null,
        accounting_date: r.accounting_date ?? null,
        period_name: r.period_name ?? null,
        period_status: r.period_status ?? null,
        source_module: r.source_module ?? null,
        source_document_type: r.source_document_type ?? null,
        source_document_id: r.source_document_id ?? null,
        document_number: r.document_number ?? null,
        description: r.description ?? null,
        branch_id: r.branch_id ?? null,
        property: r.property ?? null,
        debit: Number(r.debit ?? 0),
        credit: Number(r.credit ?? 0),
        running_balance: Number(r.running_balance ?? 0),
      }));
    },
  });
}

/**
 * Recording money received against a customer invoice.
 *
 * The database owns the rulebook: only a finance user with receipt-allocation
 * authority may collect, never more than the outstanding balance, one
 * collection intent means one receipt, and the money is posted the moment it
 * is taken — cash, bank, mobile money or card up, customer debt down. The
 * receipt therefore appears in the cashbook and in reconciliation without any
 * second, manual entry.
 */
export function useRecordCustomerReceipt() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      invoiceId: string;
      amount: number;
      method: string;
      reference?: string | undefined;
      paidOn?: string | undefined;
      notes?: string | undefined;
      campaignId?: string | undefined;
      /** Which of the hotel's accounts received the money. */
      destinationAccountId?: string | null | undefined;
    }) => {
      const { data, error } = await guardedRpc(supabase, "neo_ar_record_customer_payment", {
        _invoice: input.invoiceId,
        _amount: input.amount,
        _method: input.method,
        _reference: input.reference ?? null,
        _paid_on: input.paidOn ?? null,
        _notes: input.notes ?? null,
        _campaign: input.campaignId ?? null,
        _account: input.destinationAccountId ?? null,
      } as never);
      if (error) throw error;
      return (data ?? {}) as {
        ok?: boolean;
        payment_id?: string;
        receipt_number?: string;
        journal_id?: string | null;
        invoice_status?: string;
        invoice_balance?: number;
        duplicate_prevented?: boolean;
      };
    },
    onSuccess: (r) => {
      if (r.duplicate_prevented) toast.info("That receipt was already recorded.");
      else if (r.invoice_status === "paid")
        toast.success(`Receipt ${r.receipt_number ?? ""} recorded — invoice settled in full`.trim());
      else toast.success(`Receipt ${r.receipt_number ?? ""} recorded`.trim());
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
