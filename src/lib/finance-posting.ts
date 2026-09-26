/**
 * Finance posting workflow — the client half of the operational → Finance handoff.
 *
 * Every posting goes through `neo_finance_post_source`, which is idempotent by
 * construction: one receipt row per source record, guarded by an advisory lock
 * and the source record's own posting flag. Nothing here computes money; it
 * only asks the database to post, and reads back the receipts.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import type { FactScope } from "@/lib/facts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase as any).rpc(fn, args) as Promise<{ data: any; error: { message: string } | null }>;

export type PostingQueueRow = {
  source_module: string;
  source_id: string;
  reference: string | null;
  source_status: string;
  amount: number;
  currency: string;
  occurred_on: string;
  eligible: boolean;
  posting_status: string;
  rule: string;
  required_action: string;
  drill_to: string;
  last_error: string | null;
};

export type PostingReceipt = {
  id: string;
  branch_id: string | null;
  source_module: string;
  source_id: string;
  source_reference: string | null;
  status: string;
  amount: number;
  currency: string;
  folio_line_id: string | null;
  detail: string | null;
  attempts: number;
  last_error: string | null;
  posted_at: string | null;
  occurred_on: string | null;
  updated_at: string;
};

export type ExportRow = {
  property: string;
  currency: string;
  stream: string;
  operational_eligible: number;
  posted: number;
  reversals: number;
  net_recognised: number;
  collected: number;
  outstanding_receivable: number;
  unmatched_records: number;
  period_from: string;
  period_to: string;
};

const scopeArgs = (scope: FactScope) => ({
  _branch: scope.branchId,
  _from: scope.from,
  _to: scope.to,
});

export function usePostingQueue(scope: FactScope, enabled = true) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["finance-posting", "queue", organizationId, scope.branchId, scope.from, scope.to],
    enabled: enabled && Boolean(organizationId),
    queryFn: async (): Promise<PostingQueueRow[]> => {
      const { data, error } = await rpc("neo_finance_posting_queue", scopeArgs(scope));
      if (error) throw new Error(error.message);
      return (data ?? []) as PostingQueueRow[];
    },
  });
}

export function usePostingReceipts(scope: FactScope, status?: string, enabled = true) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [
      "finance-posting",
      "receipts",
      organizationId,
      scope.branchId,
      scope.from,
      scope.to,
      status ?? null,
    ],
    enabled: enabled && Boolean(organizationId),
    queryFn: async (): Promise<PostingReceipt[]> => {
      const { data, error } = await rpc("neo_posting_receipts", {
        ...scopeArgs(scope),
        _status: status ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as PostingReceipt[];
    },
  });
}

/** Records behind one metric, with the rule and the action that unblocks each. */
export function useEligibilityDrilldown(metric: string, scope: FactScope, enabled: boolean) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["finance-posting", "drilldown", organizationId, metric, scope.branchId, scope.from, scope.to],
    enabled: enabled && Boolean(organizationId),
    queryFn: async (): Promise<PostingQueueRow[]> => {
      const { data, error } = await rpc("neo_eligibility_drilldown", {
        _metric: metric,
        ...scopeArgs(scope),
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as PostingQueueRow[];
    },
  });
}

export function useReconciliationExport(scope: FactScope, enabled = true) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["finance-posting", "export", organizationId, scope.branchId, scope.from, scope.to],
    enabled: enabled && Boolean(organizationId),
    queryFn: async (): Promise<ExportRow[]> => {
      const { data, error } = await rpc("neo_reconciliation_export", scopeArgs(scope));
      if (error) throw new Error(error.message);
      return (data ?? []) as ExportRow[];
    },
  });
}

function useInvalidatePosting() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["finance-posting"] });
    void qc.invalidateQueries({ queryKey: ["neo-facts"] });
    void qc.invalidateQueries({ queryKey: ["finance"] });
  };
}

/** Posts a single operational record. Re-running it never creates a second charge. */
export function usePostSource() {
  const invalidate = useInvalidatePosting();
  return useMutation({
    mutationFn: async (input: { module: string; sourceId: string }) => {
      // The family poster routes deposits and guest payments to their own
      // routines and everything else to the canonical source poster.
      const { data, error } = await rpc("neo_finance_post_family", {
        _module: input.module,
        _source: input.sourceId,
        _silent: false,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: (data) => {
      if (data["ok"]) toast.success(data["reason"] === "already_posted" ? "Already posted" : "Posted to Finance");
      else toast.warning(String(data["detail"] ?? data["reason"] ?? "Not eligible to post"));
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Bounded batch: the database caps the run, so a large backlog drains in passes. */
export function usePostEligible() {
  const invalidate = useInvalidatePosting();
  return useMutation({
    mutationFn: async (input: { scope: FactScope; module?: string | null; limit?: number }) => {
      const { data, error } = await rpc("neo_finance_post_eligible", {
        ...scopeArgs(input.scope),
        _module: input.module ?? null,
        _limit: input.limit ?? 50,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, number>;
    },
    onSuccess: (r) => {
      toast.success(
        `Posted ${r["posted"] ?? 0} · blocked ${r["blocked"] ?? 0} · failed ${r["failed"] ?? 0}`,
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


/**
 * Supervised disposition of a posting receipt: retry it through the canonical
 * poster, or close it off with a written reason. Both are recorded in the
 * audit trail; neither can create a second posting.
 */
export function useReceiptAction() {
  const invalidate = useInvalidatePosting();
  return useMutation({
    mutationFn: async (input: { receiptId: string; action: "retry" | "resolve"; reason?: string }) => {
      const { data, error } = await rpc("neo_posting_receipt_action", {
        _receipt: input.receiptId,
        _action: input.action,
        _reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: (data, vars) => {
      if (data["ok"]) {
        toast.success(vars.action === "resolve" ? "Closed with a reason" : "Retried");
      } else {
        toast.warning(String(data["detail"] ?? data["reason"] ?? "No change"));
      }
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------- backfill -------------------------------- */

export type BackfillRow = {
  module: string;
  eligible: number;
  posted: number;
  skipped_ineligible: number;
  failed: number;
  duplicate_prevented: number;
};

/**
 * Historical backfill. Only records already in a finalised lifecycle are
 * posted — nothing is promoted to create revenue — and a second run reports
 * duplicates prevented rather than posting again.
 */
export function useFinanceBackfill() {
  const invalidate = useInvalidatePosting();
  return useMutation({
    mutationFn: async (input: { scope: FactScope; dryRun?: boolean }) => {
      const { data, error } = await rpc("neo_finance_backfill", {
        ...scopeArgs(input.scope),
        _dry_run: input.dryRun ?? false,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as BackfillRow[];
    },
    onSuccess: (rows, vars) => {
      const total = rows.reduce(
        (a, r) => ({
          eligible: a.eligible + r.eligible,
          posted: a.posted + r.posted,
          dup: a.dup + r.duplicate_prevented,
          failed: a.failed + r.failed,
        }),
        { eligible: 0, posted: 0, dup: 0, failed: 0 },
      );
      toast.success(
        vars.dryRun
          ? `${total.eligible} eligible record(s) found — nothing posted`
          : `Eligible ${total.eligible} · posted ${total.posted} · duplicates prevented ${total.dup} · failed ${total.failed}`,
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


export type RangeKey = "today" | "week" | "month" | "custom";

  // Finance ranges are local business dates, not UTC instants.
  const iso = (d: Date) =>
    [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");

/** Property-local ranges are resolved in the database; these are the requested bounds. */
export function rangeFor(key: RangeKey, custom?: { from: string; to: string }): { from: string; to: string } {
  const now = new Date();
  if (key === "custom" && custom?.from && custom?.to) return { from: custom.from, to: custom.to };
  if (key === "today") return { from: iso(now), to: iso(now) };
  if (key === "week") {
    const day = (now.getDay() + 6) % 7; // Monday-first
    const start = new Date(now);
    start.setDate(now.getDate() - day);
    return { from: iso(start), to: iso(now) };
  }
  return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
}

/* ------------------------------- exports -------------------------------- */

export const EXPORT_COLUMNS = [
  "Property",
  "Currency",
  "Stream",
  "Operational eligible",
  "Posted",
  "Reversals / refunds",
  "Net recognised",
  "Collected",
  "Outstanding receivable",
  "Unmatched records",
  "Period from",
  "Period to",
] as const;

const csvCell = (value: unknown) => {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function reconciliationCsv(rows: ExportRow[]): string {
  const body = rows.map((r) =>
    [
      r.property,
      r.currency,
      r.stream,
      r.operational_eligible,
      r.posted,
      r.reversals,
      r.net_recognised,
      r.collected,
      r.outstanding_receivable,
      r.unmatched_records,
      r.period_from,
      r.period_to,
    ]
      .map(csvCell)
      .join(","),
  );
  return [EXPORT_COLUMNS.join(","), ...body].join("\n");
}

export function reconciliationHtml(rows: ExportRow[], title: string): string {
  const head = EXPORT_COLUMNS.map((c) => `<th>${c}</th>`).join("");
  const body = rows
    .map(
      (r) =>
        `<tr><td>${r.property}</td><td>${r.currency}</td><td>${r.stream}</td><td>${r.operational_eligible}</td>` +
        `<td>${r.posted}</td><td>${r.reversals}</td><td>${r.net_recognised}</td><td>${r.collected}</td>` +
        `<td>${r.outstanding_receivable}</td><td>${r.unmatched_records}</td><td>${r.period_from}</td><td>${r.period_to}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;color:#020A1C;padding:24px}
h1{font-size:18px;margin:0 0 4px}p{color:#5b6472;font-size:12px;margin:0 0 16px}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{border:1px solid #dfe4ec;padding:6px 8px;text-align:left}
th{background:#f4f7fb;text-transform:uppercase;font-size:10px;letter-spacing:.04em}</style></head>
<body><h1>${title}</h1><p>NEØ Hospitality OS — reconciliation export</p>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** PDF via the browser's print dialog — no server round trip, no fake numbers. */
export function printHtml(html: string) {
  const win = window.open("", "_blank", "width=1024,height=768");
  if (!win) {
    toast.error("Allow pop-ups to produce the PDF export.");
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}

/* --------------------- drilldown: plan, journal, reversal ------------------ */

export type PostingPlanLine = {
  code: string;
  account: string;
  category: string | null;
  debit: number;
  credit: number;
  description: string;
  configured: boolean;
};

export type PostingPlan = {
  ok: boolean;
  reason?: string;
  source_type?: string;
  source_id?: string;
  module?: string;
  reference?: string | null;
  currency?: string;
  occurred_on?: string | null;
  amount?: number;
  posting_type?: string;
  eligible?: boolean;
  blocked_reason?: string | null;
  lines?: PostingPlanLine[];
  total_debit?: number;
  total_credit?: number;
  receipt?: (PostingReceipt & { journal_id: string | null; reverses_receipt_id: string | null }) | null;
  journal?: {
    id: string;
    number: string | null;
    status: string;
    accounting_date: string | null;
    total_debit: number;
    total_credit: number;
    lines: { code: string; account: string; debit: number; credit: number; description: string | null }[];
  } | null;
  reversal?: { id: string; number: string | null; accounting_date: string | null; status: string } | null;
};

/**
 * The exact entries one operational record should create, alongside whatever
 * receipt, journal and reversal already exist for it. Nothing is written.
 */
export function usePostingPlan(module: string | null, sourceId: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["finance-posting", "plan", organizationId, module, sourceId],
    enabled: Boolean(organizationId && module && sourceId),
    queryFn: async (): Promise<PostingPlan> => {
      const { data, error } = await rpc("neo_posting_plan", { _module: module, _source: sourceId });
      if (error) throw new Error(error.message);
      return (data ?? { ok: false, reason: "empty" }) as PostingPlan;
    },
  });
}

/* ------------------------- reconciliation scoreboard ---------------------- */

export type ReconciliationStatusRow = {
  module: string;
  eligible: number;
  blocked: number;
  posted: number;
  skipped: number;
  failed: number;
  duplicate_prevented: number;
  reversed: number;
};

export function useReconciliationStatus(scope: FactScope, enabled = true) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["finance-posting", "status", organizationId, scope.branchId, scope.from, scope.to],
    enabled: enabled && Boolean(organizationId),
    queryFn: async (): Promise<ReconciliationStatusRow[]> => {
      const { data, error } = await rpc("neo_reconciliation_status", scopeArgs(scope));
      if (error) throw new Error(error.message);
      return (data ?? []) as ReconciliationStatusRow[];
    },
  });
}

/* ---------------------- revenue variance reconciliation -------------------- */

/**
 * One canonical figure set per module: what operations recorded, what reached
 * Finance, and the reason for any difference. Screens read this instead of
 * summing their own totals, so a gap is always explained.
 */
export type RevenueReconciliationRow = {
  module: string;
  operational_amount: number;
  posted_amount: number;
  variance: number;
  awaiting_amount: number;
  blocked_amount: number;
  failed_amount: number;
  explanation: string;
};

export function useRevenueReconciliation(scope: FactScope, enabled = true) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["finance-posting", "revenue-variance", organizationId, scope.branchId, scope.from, scope.to],
    enabled: enabled && Boolean(organizationId),
    queryFn: async (): Promise<RevenueReconciliationRow[]> => {
      const { data, error } = await rpc("neo_revenue_reconciliation", scopeArgs(scope));
      if (error) throw new Error(error.message);
      return (data ?? []).map((r: Record<string, unknown>) => ({
        module: String(r["module"] ?? "other"),
        operational_amount: Number(r["operational_amount"] ?? 0),
        posted_amount: Number(r["posted_amount"] ?? 0),
        variance: Number(r["variance"] ?? 0),
        awaiting_amount: Number(r["awaiting_amount"] ?? 0),
        blocked_amount: Number(r["blocked_amount"] ?? 0),
        failed_amount: Number(r["failed_amount"] ?? 0),
        explanation: String(r["explanation"] ?? ""),
      }));
    },
  });
}

/** Adds any missing standard ledger accounts so postings stop failing. */
export function useEnsureChartOfAccounts() {
  const invalidate = useInvalidatePosting();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await rpc("neo_finance_ensure_accounts", {});
      if (error) throw new Error(error.message);
      return Number(data ?? 0);
    },
    onSuccess: (added) => {
      if (added > 0) toast.success(`${added} missing ledger account${added === 1 ? "" : "s"} added.`);
      else toast.info("The chart of accounts already carries every account postings need.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}



/* ------------------------------ outbox replay ----------------------------- */

/** Retrying an already-processed handoff reports it rather than repeating it. */
export function useOutboxReplay() {
  const invalidate = useInvalidatePosting();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { eventId: string; reason?: string | null }) => {
      const { data, error } = await rpc("neo_outbox_replay", {
        _event: input.eventId,
        _reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: (r) => {
      if (r["reason"] === "already_processed") toast.info("Already processed — nothing was replayed.");
      else if (r["ok"]) toast.success("Handoff requeued.");
      else toast.warning(String(r["detail"] ?? r["reason"] ?? "Could not replay this handoff."));
      invalidate();
      void qc.invalidateQueries({ queryKey: ["intelligence"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useOutboxReplayBatch() {
  const invalidate = useInvalidatePosting();
  return useMutation({
    mutationFn: async (input: { branchId: string | null; limit?: number; reason?: string | null }) => {
      const { data, error } = await rpc("neo_outbox_replay_batch", {
        _branch: input.branchId,
        _limit: input.limit ?? 25,
        _reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, number | boolean>;
    },
    onSuccess: (r) =>
      toast.success(
        `Requeued ${r["requeued"] ?? 0} · already processed ${r["already_processed"] ?? 0} · failed ${r["failed"] ?? 0}`,
      ),
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------- exception register ----------------------------- */

/**
 * The single authoritative exception dataset. Dashboard counters and the
 * Posting & Reconciliation screen both read this, so a tile that says
 * "15 blocked" always drills into exactly those fifteen records.
 */
export type FinanceExceptionRow = {
  kind: "blocked" | "failed" | string;
  module: string;
  reference: string | null;
  source_id: string;
  amount: number;
  currency: string;
  occurred_on: string | null;
  age_days: number;
  status: string;
  reason: string;
  detail: string | null;
  responsible: string;
  action: string;
  drill_to: string;
  last_attempt: string | null;
  attempts: number;
  last_error: string | null;
  branch_id: string | null;
  property: string | null;
};

export function useFinanceExceptions(scope: FactScope, enabled = true) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["finance-posting", "exceptions", organizationId, scope.branchId, scope.from, scope.to],
    enabled: enabled && Boolean(organizationId),
    queryFn: async (): Promise<FinanceExceptionRow[]> => {
      const { data, error } = await rpc("neo_finance_exception_register", scopeArgs(scope));
      if (error) throw new Error(error.message);
      return (data ?? []).map((r: Record<string, unknown>) => ({
        kind: String(r["kind"] ?? "blocked"),
        module: String(r["module"] ?? "other"),
        reference: (r["reference"] as string) ?? null,
        source_id: String(r["source_id"] ?? ""),
        amount: Number(r["amount"] ?? 0),
        currency: String(r["currency"] ?? "KES"),
        occurred_on: (r["occurred_on"] as string) ?? null,
        age_days: Number(r["age_days"] ?? 0),
        status: String(r["status"] ?? "blocked"),
        reason: String(r["reason"] ?? ""),
        detail: (r["detail"] as string) ?? null,
        responsible: String(r["responsible"] ?? "Operations"),
        action: String(r["action"] ?? ""),
        drill_to: String(r["drill_to"] ?? "/finance/posting"),
        last_attempt: (r["last_attempt"] as string) ?? null,
        attempts: Number(r["attempts"] ?? 0),
        last_error: (r["last_error"] as string) ?? null,
        branch_id: (r["branch_id"] as string) ?? null,
        property: (r["property"] as string) ?? null,
      }));
    },
  });
}

/* ------------------------- source integrity ------------------------------- */

export type SourceIntegrity = {
  ok: boolean;
  reference?: string | null;
  status?: string | undefined;
  lines?: number | undefined;
  line_total?: number | undefined;
  subtotal?: number | undefined;
  tax?: number | undefined;
  service_charge?: number | undefined;
  discount?: number | undefined;
  grand_total?: number | undefined;
  issues: { code: string; detail: string }[];
};

/** Reads the canonical integrity verdict for one operational record. */
export function useSourceIntegrity(module: string | null, sourceId: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["finance-posting", "integrity", organizationId, module, sourceId],
    enabled: Boolean(organizationId && module && sourceId),
    queryFn: async (): Promise<SourceIntegrity> => {
      const { data, error } = await rpc("neo_source_integrity", { _module: module, _source: sourceId });
      if (error) throw new Error(error.message);
      const d = (data ?? {}) as Record<string, unknown>;
      return {
        ok: Boolean(d["ok"]),
        reference: (d["reference"] as string) ?? null,
        status: (d["status"] as string) ?? undefined,
        lines: d["lines"] === undefined ? undefined : Number(d["lines"]),
        line_total: d["line_total"] === undefined ? undefined : Number(d["line_total"]),
        subtotal: d["subtotal"] === undefined ? undefined : Number(d["subtotal"]),
        tax: d["tax"] === undefined ? undefined : Number(d["tax"]),
        service_charge: d["service_charge"] === undefined ? undefined : Number(d["service_charge"]),
        discount: d["discount"] === undefined ? undefined : Number(d["discount"]),
        grand_total: d["grand_total"] === undefined ? undefined : Number(d["grand_total"]),
        issues: ((d["issues"] as { code: string; detail: string }[]) ?? []).map((i) => ({
          code: String(i.code),
          detail: String(i.detail),
        })),
      };
    },
  });
}
