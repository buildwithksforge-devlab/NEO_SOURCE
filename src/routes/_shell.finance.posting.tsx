/**
 * Finance posting workflow.
 *
 * Operational records reach Finance automatically when they are finalised;
 * this screen exists for the exceptions — records blocked by an eligibility
 * rule, and postings that failed and need a retry. Every action is idempotent,
 * and every attempt leaves a visible receipt.
 */
import { useMemo, useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { LoadingState } from "@/components/common/StateSystem";
import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowUpRight, Download, FileText, RefreshCw, Send } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { ExceptionRegister } from "@/components/finance/ExceptionRegister";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FinanceEmpty, FinanceGuard, financeHead } from "@/components/finance/FinanceShared";
import { PostingPlanDialog, type PostingPlanTarget } from "@/components/finance/PostingPlanDialog";
import { ReconciliationStatusPanel } from "@/components/finance/ReconciliationStatus";
import { RevenueVariancePanel } from "@/components/finance/RevenueVariance";
import { useFinanceFactScope } from "@/lib/finance-data";
import { useAuth } from "@/lib/auth";
import {
  downloadCsv,
  printHtml,
  rangeFor,
  reconciliationCsv,
  reconciliationHtml,
  useEnsureChartOfAccounts,
  useFinanceBackfill,
  usePostEligible,
  useFinanceExceptions,
  usePostSource,
  usePostingQueue,
  useReceiptAction,
  usePostingReceipts,
  useReconciliationExport,
  type PostingQueueRow,
  type RangeKey,
} from "@/lib/finance-posting";

export const Route = createFileRoute("/_shell/finance/posting")({
  head: financeHead(
    "Finance posting & reconciliation",
    "Finalise eligible operational records into Finance with idempotent retries, visible posting receipts and reconciliation exports.",
  ),
  // A Finance counter that reads "16 blocked" drills straight into those rows.
  validateSearch: (search: Record<string, unknown>) => ({
    kind: typeof search["kind"] === "string" ? (search["kind"] as string) : undefined,
    module: typeof search["module"] === "string" ? (search["module"] as string) : undefined,
  }),
  component: () => (
    <FinanceGuard feature="reconciliation" action="edit">
      <FinancePosting />
    </FinanceGuard>
  ),
});


const MODULES = [
  { value: "all", label: "All modules" },
  { value: "pos", label: "POS" },
  { value: "folio", label: "Folios" },
  { value: "events", label: "Events" },
  { value: "laundry", label: "Laundry" },
  { value: "delivery", label: "Delivery" },
  { value: "inventory", label: "Inventory receipts (GRN)" },
  { value: "supplier_invoice", label: "Supplier invoices" },
  { value: "supplier_payment", label: "Supplier payments" },
];

const money = (v: unknown, currency: string) =>
  `${currency} ${new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(Number(v ?? 0))}`;

function FinancePosting() {
  const { can } = useAuth();
  const search = Route.useSearch();
  const mayExport = can("finance", "reconciliation", "export") || can("finance", "reports", "export");

  const base = useFinanceFactScope();
  const [range, setRange] = useState<RangeKey>("month");
  const [custom, setCustom] = useState({ from: base.from, to: base.to });
  const [module, setModule] = useState("all");

  const bounds = rangeFor(range, custom);
  const scope = { branchId: base.branchId, from: bounds.from, to: bounds.to };

  const queue = usePostingQueue(scope);
  const receipts = usePostingReceipts(scope);
  const exportRows = useReconciliationExport(scope);
  const postOne = usePostSource();
  const postBatch = usePostEligible();
  const backfill = useFinanceBackfill();
  const ensureAccounts = useEnsureChartOfAccounts();
  const [plan, setPlan] = useState<PostingPlanTarget | null>(null);
  const receiptAction = useReceiptAction();
  const [closing, setClosing] = useState<{ id: string; reference: string } | null>(null);
  const [closeReason, setCloseReason] = useState("");

  const rows = useMemo(
    () => (queue.data ?? []).filter((r) => module === "all" || r.source_module === module),
    [queue.data, module],
  );
  const eligible = rows.filter((r) => r.eligible);
  // Blocked and failed counters read the exception register, so every tile in
  // Finance and this screen count exactly the same records.
  const exceptions = useFinanceExceptions(scope);
  const exceptionRows = useMemo(
    () => (exceptions.data ?? []).filter((r) => module === "all" || r.module === module),
    [exceptions.data, module],
  );
  const blocked = exceptionRows.filter((r) => r.kind === "blocked");
  const failed = exceptionRows.filter((r) => r.kind === "failed");
  const currency = rows[0]?.currency ?? exportRows.data?.[0]?.currency ?? "";

  const label = `${bounds.from} → ${bounds.to}`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Posting & reconciliation"
        description="Operational records post to Finance the moment they are finalised. Anything listed here is waiting on an eligibility rule or a retry — posting twice is impossible."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                void queue.refetch();
                void receipts.refetch();
                void exportRows.refetch();
              }}
            >
              <RefreshCw className="mr-2 size-4" /> Refresh
            </Button>
            <Button
              disabled={eligible.length === 0 || postBatch.isPending}
              onClick={() =>
                postBatch.mutate({ scope, module: module === "all" ? null : module, limit: 50 })
              }
            >
              <Send className="mr-2 size-4" /> Post {eligible.length} eligible
            </Button>
          </div>
        }
      />

      <SectionCard
        title="Period and scope"
        description="Property-local dates, resolved in the database."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-44">
            <Label className="mb-1 block text-xs">Range</Label>
            <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="week">This week</SelectItem>
                <SelectItem value="month">This month</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {range === "custom" ? (
            <>
              <div>
                <Label className="mb-1 block text-xs">From</Label>
                <NeoDatePicker
                  value={custom.from}
                  onChange={(v) => setCustom((c) => ({ ...c, from: v }))}
                  quick={["today", "this-week", "next-7", "this-month"]}
                />
              </div>
              <div>
                <Label className="mb-1 block text-xs">To</Label>
                <NeoDatePicker
                  value={custom.to}
                  onChange={(v) => setCustom((c) => ({ ...c, to: v }))}
                  quick={["today", "this-week", "next-7", "this-month"]}
                />
              </div>
            </>
          ) : null}
          <div className="w-48">
            <Label className="mb-1 block text-xs">Module</Label>
            <Select value={module} onValueChange={setModule}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODULES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              disabled={!mayExport || (exportRows.data ?? []).length === 0}
              onClick={() =>
                downloadCsv(
                  `neo-reconciliation-${bounds.from}-to-${bounds.to}.csv`,
                  reconciliationCsv(exportRows.data ?? []),
                )
              }
            >
              <Download className="mr-2 size-4" /> CSV
            </Button>
            <Button
              variant="outline"
              disabled={!mayExport || (exportRows.data ?? []).length === 0}
              onClick={() =>
                printHtml(reconciliationHtml(exportRows.data ?? [], `Reconciliation ${label}`))
              }
            >
              <FileText className="mr-2 size-4" /> PDF
            </Button>
          </div>
        </div>
      </SectionCard>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Ready to post"
          value={queue.isLoading ? "…" : String(eligible.length)}
          icon={Send}
          tone="success"
          hint={label}
        />
        <StatCard
          label="Blocked by a rule"
          value={exceptions.isLoading ? "…" : String(blocked.length)}
          icon={AlertTriangle}
          tone="warning"
          hint="Action required on the source record"
        />
        <StatCard
          label="Failed postings"
          value={exceptions.isLoading ? "…" : String(failed.length)}
          icon={RefreshCw}
          tone="warning"
          hint="Retry is safe — postings are idempotent"
        />
        <StatCard
          label="Receipts in period"
          value={receipts.isLoading ? "…" : String((receipts.data ?? []).length)}
          icon={FileText}
          hint="Every attempt is recorded"
        />
      </div>

      <ExceptionRegister
        scope={scope}
        retrying={receiptAction.isPending}
        initialKind={search.kind ?? "all"}
        moduleFilter={search.module ?? "all"}
        onRetry={(row) =>
          postOne.mutate({ module: row.module, sourceId: row.source_id })
        }
      />


      <SectionCard
        title="Historical backfill"
        description="Posts records that are already in a finalised lifecycle. Nothing is promoted to create revenue, and a repeat run reports duplicates prevented instead of posting again."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={backfill.isPending}
            onClick={() => backfill.mutate({ scope, dryRun: true })}
          >
            Preview eligible records
          </Button>
          <Button disabled={backfill.isPending} onClick={() => backfill.mutate({ scope })}>
            Run backfill for {label}
          </Button>
          <Button
            variant="outline"
            disabled={ensureAccounts.isPending}
            onClick={() => ensureAccounts.mutate()}
            title="Adds any standard ledger account the posting engine needs and this chart of accounts is missing. Existing accounts are never changed."
          >
            Complete chart of accounts
          </Button>
        </div>
        {backfill.data ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[0.68rem] uppercase tracking-wide text-muted-foreground">
                  <th className="py-2">Module</th>
                  <th className="py-2 text-right">Eligible</th>
                  <th className="py-2 text-right">Posted</th>
                  <th className="py-2 text-right">Skipped (ineligible)</th>
                  <th className="py-2 text-right">Failed</th>
                  <th className="py-2 text-right">Duplicates prevented</th>
                </tr>
              </thead>
              <tbody>
                {backfill.data.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-3 text-sm text-muted-foreground">
                      No record in this period is in a finalised lifecycle, so nothing was posted.
                    </td>
                  </tr>
                ) : (
                  backfill.data.map((r) => (
                    <tr key={r.module} className="border-b border-border/60 last:border-0">
                      <td className="py-2 text-foreground">{r.module}</td>
                      <td className="py-2 text-right tabular-nums">{r.eligible}</td>
                      <td className="py-2 text-right tabular-nums">{r.posted}</td>
                      <td className="py-2 text-right tabular-nums">{r.skipped_ineligible}</td>
                      <td className="py-2 text-right tabular-nums">{r.failed}</td>
                      <td className="py-2 text-right tabular-nums">{r.duplicate_prevented}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : null}
      </SectionCard>

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Posting queue</TabsTrigger>
          <TabsTrigger value="receipts">Posting receipts</TabsTrigger>
          <TabsTrigger value="reconciliation">Reconciliation export</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-4">
          <SectionCard
            title="Unposted operational records"
            description="Each row states the rule that governs it and the action that makes it eligible."
          >
            {queue.isLoading ? (
              <LoadingState variant="cards" rows={3} />
            ) : queue.error ? (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="size-4" /> The queue could not be read.
              </p>
            ) : rows.length === 0 ? (
              <FinanceEmpty
                title="Nothing waiting to post"
                description="Every eligible operational record in this period and property has already reached Finance."
              />
            ) : (
              <QueueTable
                rows={rows}
                onPost={(r) => postOne.mutate({ module: r.source_module, sourceId: r.source_id })}
                onExplain={(r) =>
                  setPlan({
                    module: r.source_module,
                    sourceId: r.source_id,
                    reference: r.reference,
                  })
                }
                busy={postOne.isPending}
              />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="receipts" className="mt-4">
          <SectionCard
            title="Posting receipts"
            description="The audit trail of every posting attempt, including duplicates that were correctly refused."
          >
            {receipts.isLoading ? (
              <LoadingState variant="cards" rows={3} />
            ) : (receipts.data ?? []).length === 0 ? (
              <FinanceEmpty
                title="No postings in this period"
                description="Receipts appear as operational records are finalised."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4">Module</th>
                      <th className="py-2 pr-4">Reference</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4">Amount</th>
                      <th className="py-2 pr-4">Attempts</th>
                      <th className="py-2 pr-4">Posted</th>
                      <th className="py-2 pr-4">Detail</th>
                      <th className="py-2 pr-4" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(receipts.data ?? []).map((r) => (
                      <tr key={r.id}>
                        <td className="py-2 pr-4">{r.source_module}</td>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {r.source_reference || r.source_id}
                        </td>
                        <td className="py-2 pr-4">
                          <StatusPill
                            tone={
                              r.status === "posted"
                                ? "success"
                                : r.status === "failed"
                                  ? "destructive"
                                  : "warning"
                            }
                          >
                            {r.status}
                          </StatusPill>
                        </td>
                        <td className="py-2 pr-4">{money(r.amount, r.currency || currency)}</td>
                        <td className="py-2 pr-4">{r.attempts}</td>
                        <td className="py-2 pr-4 text-muted-foreground">
                          {r.posted_at ? new Date(r.posted_at).toLocaleString() : "—"}
                        </td>
                        <td className="py-2 pr-4 text-xs text-muted-foreground">
                          {r.last_error || r.detail || "—"}
                        </td>
                        <td className="py-2 pr-4">
                          {r.status === "failed" || r.status === "blocked" ? (
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={receiptAction.isPending}
                                onClick={() =>
                                  receiptAction.mutate({ receiptId: r.id, action: "retry" })
                                }
                              >
                                Retry
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setCloseReason("");
                                  setClosing({
                                    id: r.id,
                                    reference: r.source_reference || r.source_id,
                                  });
                                }}
                              >
                                Close with reason
                              </Button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="reconciliation" className="mt-4">
          <SectionCard
            title={`Reconciliation ${label}`}
            description="Operational eligible → posted → reversals → net recognised → collected → outstanding, by property and currency."
          >
            {exportRows.isLoading ? (
              <LoadingState variant="cards" rows={3} />
            ) : (exportRows.data ?? []).length === 0 ? (
              <FinanceEmpty
                title="Nothing to reconcile"
                description="No operational value arose in this period for the selected property."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4">Property</th>
                      <th className="py-2 pr-4">Currency</th>
                      <th className="py-2 pr-4">Stream</th>
                      <th className="py-2 pr-4">Eligible</th>
                      <th className="py-2 pr-4">Posted</th>
                      <th className="py-2 pr-4">Reversals</th>
                      <th className="py-2 pr-4">Net recognised</th>
                      <th className="py-2 pr-4">Collected</th>
                      <th className="py-2 pr-4">Outstanding</th>
                      <th className="py-2 pr-4">Unmatched</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(exportRows.data ?? []).map((r, i) => (
                      <tr key={`${r.property}-${r.currency}-${r.stream}-${i}`}>
                        <td className="py-2 pr-4">{r.property}</td>
                        <td className="py-2 pr-4">{r.currency}</td>
                        <td className="py-2 pr-4 font-medium">{r.stream}</td>
                        <td className="py-2 pr-4">{money(r.operational_eligible, r.currency)}</td>
                        <td className="py-2 pr-4">{money(r.posted, r.currency)}</td>
                        <td className="py-2 pr-4">{money(r.reversals, r.currency)}</td>
                        <td className="py-2 pr-4 font-semibold">
                          {money(r.net_recognised, r.currency)}
                        </td>
                        <td className="py-2 pr-4">{money(r.collected, r.currency)}</td>
                        <td className="py-2 pr-4">{money(r.outstanding_receivable, r.currency)}</td>
                        <td className="py-2 pr-4">{r.unmatched_records}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>

      <RevenueVariancePanel scope={scope} />

      <ReconciliationStatusPanel scope={scope} />
      <Dialog open={Boolean(closing)} onOpenChange={(open) => !open && setClosing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close this posting without recognising it</DialogTitle>
            <DialogDescription>
              {closing?.reference} — nothing is posted to the ledger. The reason is kept in the
              audit trail.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
            placeholder="Why is this record not chargeable?"
            rows={3}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setClosing(null)}>
              Cancel
            </Button>
            <Button
              disabled={!closeReason.trim() || receiptAction.isPending}
              onClick={() => {
                if (!closing) return;
                receiptAction.mutate(
                  { receiptId: closing.id, action: "resolve", reason: closeReason.trim() },
                  { onSuccess: () => setClosing(null) },
                );
              }}
            >
              Close posting
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PostingPlanDialog target={plan} onClose={() => setPlan(null)} />
    </div>
  );
}

function QueueTable({
  rows,
  onPost,
  onExplain,
  busy,
}: {
  rows: PostingQueueRow[];
  onPost: (row: PostingQueueRow) => void;
  onExplain: (row: PostingQueueRow) => void;
  busy: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-2 pr-3">Record</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Amount</th>
            <th className="py-2 pr-3">Date</th>
            <th className="py-2 pr-3">Rule</th>
            <th className="py-2 pr-3">Action required</th>
            <th className="py-2 pr-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={`${r.source_module}:${r.source_id}`}>
              <td className="py-2 pr-3">
                <span className="font-mono text-xs">{r.reference || r.source_id}</span>
                <span className="ml-2 text-xs text-muted-foreground">{r.source_module}</span>
              </td>
              <td className="py-2 pr-3">
                <StatusPill tone={r.eligible ? "success" : "warning"}>
                  {r.eligible ? "Ready to post" : r.source_status}
                </StatusPill>
              </td>
              <td className="py-2 pr-3">{money(r.amount, r.currency)}</td>
              <td className="py-2 pr-3">{r.occurred_on}</td>
              <td className="py-2 pr-3 text-xs text-muted-foreground">{r.rule}</td>
              <td className="py-2 pr-3 text-xs font-medium">{r.required_action}</td>
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  {r.eligible ? (
                    <Button size="sm" disabled={busy} onClick={() => onPost(r)}>
                      Post
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => onExplain(r)}>
                    Explain
                  </Button>
                  <Link
                    to={r.drill_to}
                    className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                  >
                    Open <ArrowUpRight className="size-3" />
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
