/**
 * Bank transfer verification.
 *
 * Typing a transfer reference at the till is not proof the money arrived. NEØ
 * records that tender as received-but-unverified, and it only becomes verified
 * when a line on the bank's own statement — same amount, same reference — is
 * matched to it. Withdrawing a match puts the payment straight back to
 * unverified, so the state can never drift away from the bank.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

export type StatementCandidate = {
  entry_id: string;
  value_date: string;
  amount: number;
  reference: string | null;
  description: string | null;
  exact_reference: boolean;
};

export type AwaitingTransfer = {
  attempt_id: string;
  amount: number;
  currency: string | null;
  reference: string | null;
  module: string | null;
  branch_id: string | null;
  requested_at: string;
  state: string;
  state_detail: string | null;
  candidates: StatementCandidate[];
};

export type OpenStatementLine = {
  entry_id: string;
  bank_account_id: string;
  value_date: string;
  amount: number;
  direction: string;
  reference: string | null;
  description: string | null;
};

export type TransferQueue = {
  ok: boolean;
  reason?: string;
  awaiting: AwaitingTransfer[];
  open_lines: OpenStatementLine[];
  accounts: number;
  from?: string;
  to?: string;
};

export type ReconciliationAccount = {
  account_id: string;
  name: string;
  bank_name: string | null;
  currency: string | null;
  lines: number;
  money_in: number;
  money_out: number;
  matched_lines: number;
  matched_amount: number;
  open_lines: number;
  open_amount: number;
};

export type ReconciliationIssue = {
  kind: string;
  severity: string;
  title: string;
  detail: string;
  amount: number;
  reference: string | null;
  occurred_at: string;
  attempt_id?: string;
  entry_id?: string;
};

export type ReconciliationOverview = {
  ok: boolean;
  reason?: string;
  from?: string;
  to?: string;
  accounts: ReconciliationAccount[];
  transfers?: {
    awaiting_count: number;
    awaiting_amount: number;
    verified_count: number;
    verified_amount: number;
  };
  issues: ReconciliationIssue[];
  issue_count: number;
};

export function useBankReconciliationOverview(opts?: {
  branchId?: string | null;
  from?: string;
  to?: string;
}) {
  return useQuery<ReconciliationOverview>({
    queryKey: ["bank-reconciliation", opts?.branchId ?? "all", opts?.from ?? null, opts?.to ?? null],
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_bank_reconciliation_overview", {
        _branch: opts?.branchId ?? null,
        _from: opts?.from ?? null,
        _to: opts?.to ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? { ok: false, accounts: [], issues: [], issue_count: 0 }) as ReconciliationOverview;
    },
  });
}

export function useBankTransferQueue(branchId?: string | null) {
  return useQuery<TransferQueue>({
    queryKey: ["bank-transfer-queue", branchId ?? "all"],
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_bank_transfer_queue", {
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? { ok: false, awaiting: [], open_lines: [], accounts: 0 }) as TransferQueue;
    },
  });
}

function useBankRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["bank-transfer-queue"] });
    void qc.invalidateQueries({ queryKey: ["statement-entries"] });
    void qc.invalidateQueries({ queryKey: ["payment-register"] });
    void qc.invalidateQueries({ queryKey: ["bank-reconciliation"] });
  };
}

type RpcResult = { ok?: boolean; reason?: string; detail?: string; imported?: number; skipped?: number; matched?: number; proposal_count?: number };

const REASONS: Record<string, string> = {
  account_not_found: "That bank account is not in this workspace.",
  rows_not_a_list: "The statement could not be read.",
  statement_line_not_found: "That statement line no longer exists.",
  payment_not_found: "That payment is not in this workspace.",
  line_already_matched: "That statement line is already matched to another payment.",
  already_verified: "That payment has already been verified.",
  amount_mismatch: "The bank line and the payment are not the same amount.",
  line_not_matched: "That statement line is not matched to anything.",
  reason_required: "Say why the match is being withdrawn.",
};

function explain(r: RpcResult) {
  return r.detail ?? REASONS[String(r.reason)] ?? "That could not be completed.";
}

export type StatementRowInput = {
  value_date: string;
  amount: number;
  reference?: string | null;
  description?: string | null;
  fees?: number;
};

export function useImportStatement() {
  const refresh = useBankRefresh();
  return useMutation({
    mutationFn: async (input: { accountId: string; rows: StatementRowInput[] }) => {
      const { data, error } = await guardedRpc(supabase, "neo_bank_statement_import", {
        _account: input.accountId,
        _rows: input.rows,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as RpcResult;
      if (!result.ok) throw new Error(explain(result));
      return result;
    },
    onSuccess: (r) => {
      refresh();
      toast.success(`${r.imported ?? 0} lines imported, ${r.skipped ?? 0} already on file`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useMatchTransfer() {
  const refresh = useBankRefresh();
  return useMutation({
    mutationFn: async (input: { attemptId: string; entryId: string; note?: string }) => {
      const { data, error } = await guardedRpc(supabase, "neo_bank_match_transfer", {
        _attempt: input.attemptId,
        _entry: input.entryId,
        _note: input.note ?? null,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as RpcResult;
      if (!result.ok) throw new Error(explain(result));
      return result;
    },
    onSuccess: () => {
      refresh();
      toast.success("Transfer verified against the bank statement");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAutoMatchTransfers() {
  const refresh = useBankRefresh();
  return useMutation({
    mutationFn: async (input: { branchId?: string | null; commit: boolean }) => {
      const { data, error } = await guardedRpc(supabase, "neo_bank_auto_match", {
        _branch: input.branchId ?? null,
        _commit: input.commit,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as RpcResult;
      if (!result.ok) throw new Error(explain(result));
      return result;
    },
    onSuccess: (r, vars) => {
      refresh();
      toast.success(
        vars.commit
          ? `${r.matched ?? 0} transfers verified`
          : `${r.proposal_count ?? 0} exact matches found`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUnmatchTransfer() {
  const refresh = useBankRefresh();
  return useMutation({
    mutationFn: async (input: { entryId: string; reason: string }) => {
      const { data, error } = await guardedRpc(supabase, "neo_bank_unmatch_transfer", {
        _entry: input.entryId,
        _reason: input.reason,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as RpcResult;
      if (!result.ok) throw new Error(explain(result));
      return result;
    },
    onSuccess: () => {
      refresh();
      toast.success("Match withdrawn; the payment is unverified again");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Marks a transfer reconciled when no bank line will ever exist for it — a
 * netted settlement, a correction, a payment the bank shows under a different
 * amount. It demands a written reason and is recorded against the person who
 * gave it, because this is Finance's word standing in for the bank's.
 */
export function useMarkTransferReconciled() {
  const refresh = useBankRefresh();
  return useMutation({
    mutationFn: async (input: { attemptId: string; reason: string }) => {
      const { data, error } = await guardedRpc(supabase, "neo_bank_mark_transfer_reconciled", {
        _attempt: input.attemptId,
        _reason: input.reason,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as RpcResult;
      if (!result.ok) throw new Error(explain(result));
      return result;
    },
    onSuccess: () => {
      refresh();
      toast.success("Transfer marked reconciled, with your reason on the record");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Explains a bank line that is not a payment at all — a charge, interest, a sweep. */
export function useMarkLineReconciled() {
  const refresh = useBankRefresh();
  return useMutation({
    mutationFn: async (input: { entryId: string; reason: string }) => {
      const { data, error } = await guardedRpc(supabase, "neo_bank_mark_line_reconciled", {
        _entry: input.entryId,
        _reason: input.reason,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as RpcResult;
      if (!result.ok) throw new Error(explain(result));
      return result;
    },
    onSuccess: () => {
      refresh();
      toast.success("Bank line explained");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Reads a pasted bank export. Header row optional; date, amount, reference, description. */
export function parseStatementCsv(text: string): { rows: StatementRowInput[]; problems: string[] } {
  const rows: StatementRowInput[] = [];
  const problems: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  lines.forEach((line, i) => {
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cells.length < 2) return;
    const [rawDate, rawAmount, reference, description] = cells;
    if (i === 0 && Number.isNaN(Number(rawAmount?.replace(/[, ]/g, "")))) return; // header
    const value_date = normaliseDate(rawDate ?? "");
    const amount = Number((rawAmount ?? "").replace(/[, ]/g, ""));
    if (!value_date || !Number.isFinite(amount) || amount === 0) {
      problems.push(`Line ${i + 1} could not be read`);
      return;
    }
    rows.push({
      value_date,
      amount,
      reference: reference || null,
      description: description || null,
    });
  });
  return { rows, problems };
}

function normaliseDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
