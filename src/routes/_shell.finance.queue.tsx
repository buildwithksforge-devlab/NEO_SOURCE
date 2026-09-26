/**
 * The canonical cashier queue.
 *
 * One conveyor, two stages. **Awaiting collection** is money a department has
 * billed but nobody has taken yet; **awaiting posting** is money taken but not
 * yet recognised in the ledger. `/finance/collections` redirects here so the
 * two stages can never disagree about the same transaction.
 *
 * The posting stage is read from `neo_finance_posting_queue`, so its status is
 * held in the database, not in this page — it survives a refresh, a reopen and
 * a new sign-in. Posting is repeat-safe: retrying a row already recognised
 * returns the same journal instead of writing a second one.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DataTable,
  FinanceEmpty,
  FinanceGuard,
  FinanceQueryState,
  FinStatus,
  financeHead,
} from "@/components/finance/FinanceShared";
import { CollectionStage } from "@/components/finance/CollectionStage";
import { money, shortDate, titleCase } from "@/lib/finance";
import { useAuth } from "@/lib/auth";
import { useFinanceFactScope } from "@/lib/finance-data";
import { usePostEligible, usePostSource, usePostingQueue } from "@/lib/finance-posting";

type QueueSearch = { stage?: "collect" | "post" | undefined };

export const Route = createFileRoute("/_shell/finance/queue")({
  validateSearch: (search: Record<string, unknown>): QueueSearch => ({
    stage: search["stage"] === "collect" ? "collect" : search["stage"] === "post" ? "post" : undefined,
  }),
  head: financeHead(
    "Cashier Queue",
    "One queue for money awaiting collection and money awaiting recognition in Finance, with posting status, blockers and a safe retry.",
  ),
  component: () => (
    <FinanceGuard feature="collections" action="view">
      <PaymentQueuePage />
    </FinanceGuard>
  ),
});


/** The families a cashier's money passes through. */
const CASHIER_MODULES = ["payment", "deposit", "pos", "folio", "laundry"] as const;

const FILTERS = [
  { value: "all", label: "All cashier sources" },
  { value: "payment", label: "Till & folio payments" },
  { value: "deposit", label: "Pre-arrival deposits" },
  { value: "pos", label: "Point-of-sale bills" },
  { value: "folio", label: "Room charges" },
  { value: "laundry", label: "Guest laundry" },
];

const MODULE_LABEL: Record<string, string> = {
  payment: "Till / folio payment",
  deposit: "Pre-arrival deposit",
  pos: "Point-of-sale bill",
  folio: "Room charge",
  laundry: "Guest laundry",
};

function PaymentQueuePage() {
  const { can } = useAuth();
  const scope = useFinanceFactScope();
  const queue = usePostingQueue(scope);
  const postOne = usePostSource();
  const postBatch = usePostEligible();
  const [filter, setFilter] = useState("all");

  /** Recognising money is a separate authority from collecting it. */
  const maySeePosting = can("finance", "reconciliation", "view") || can("finance", "gl", "view");
  const mayPost = can("finance", "reconciliation", "edit") || can("finance", "gl", "post");

  const rows = useMemo(() => {
    const all = (queue.data ?? []).filter((r) =>
      (CASHIER_MODULES as readonly string[]).includes(r.source_module),
    );
    return filter === "all" ? all : all.filter((r) => r.source_module === filter);
  }, [queue.data, filter]);

  const eligible = rows.filter((r) => r.eligible);
  const blocked = rows.filter((r) => !r.eligible);
  const failed = rows.filter((r) => r.posting_status === "failed");
  const value = eligible.reduce((s, r) => s + Number(r.amount ?? 0), 0);

  const lead: SummaryFigure = {
    id: "queued",
    label: "Waiting to post",
    value: queue.isLoading ? "…" : rows.length,
    hint: "Held in the database — the status survives a refresh",
  };
  const figures: SummaryFigure[] = [
    { id: "eligible", label: "Ready to post", value: queue.isLoading ? "…" : eligible.length },
    { id: "value", label: "Value ready", value: queue.isLoading ? "…" : money(value) },
    {
      id: "blocked",
      label: "Blocked",
      value: queue.isLoading ? "…" : blocked.length,
      tone: blocked.length ? "warning" : "success",
    },
    {
      id: "failed",
      label: "Failed",
      value: queue.isLoading ? "…" : failed.length,
      tone: failed.length ? "destructive" : "success",
    },
  ];

  const search = Route.useSearch();
  const [stage, setStage] = useState<string>(search.stage ?? "collect");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Cashier queue"
        description="One queue, two stages: bills a department has raised and nobody has collected yet, then money taken but not yet recognised in the ledger. Nothing is posted twice, and End of Day reads the same queue."
        actions={
          mayPost && stage === "post" ? (
            <Button
              disabled={eligible.length === 0 || postBatch.isPending}
              onClick={() =>
                postBatch.mutate({
                  scope,
                  module: filter === "all" ? null : filter,
                  limit: 50,
                })
              }
            >
              <RefreshCw className="mr-2 size-4" />
              Post everything ready ({eligible.length})
            </Button>
          ) : null
        }
      />

      <Tabs value={stage} onValueChange={setStage} className="space-y-4">
        <TabsList>
          <TabsTrigger value="collect">Awaiting collection</TabsTrigger>
          {maySeePosting ? (
            <TabsTrigger value="post">
              Awaiting posting{rows.length ? ` (${rows.length})` : ""}
            </TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="collect">
          <CollectionStage />
        </TabsContent>

        <TabsContent value="post" className="space-y-6">
      <SummaryStrip lead={lead} figures={figures} />

      <div className="grid gap-1.5 rounded-xl border border-border/70 bg-card p-4 sm:max-w-xs">

        <Label htmlFor="queue-filter">Source</Label>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger id="queue-filter" aria-label="Filter the queue by source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl border border-border/70 bg-card p-4">
        <FinanceQueryState
          isLoading={queue.isLoading}
          error={queue.error}
          isEmpty={rows.length === 0}
          empty={
            <FinanceEmpty
              title="Nothing waiting"
              description="Every cashier payment, deposit, room charge and point-of-sale bill in this period has been recognised in the ledger."
            />
          }
        >
          <DataTable
            unit="queued postings"
            head={[
              "Source",
              "Reference",
              "Date",
              "Amount",
              "Record status",
              "Posting",
              "What it needs",
              "",
            ]}
          >
            {rows.map((r) => (
              <tr key={`${r.source_module}:${r.source_id}`}>
                <td className="py-2 pr-4">
                  {MODULE_LABEL[r.source_module] ?? titleCase(r.source_module)}
                </td>
                <td className="py-2 pr-4 font-mono text-xs">{r.reference ?? "—"}</td>
                <td className="py-2 pr-4 whitespace-nowrap">
                  {r.occurred_on ? shortDate(r.occurred_on) : "—"}
                </td>
                <td className="py-2 pr-4 text-right">{money(r.amount)}</td>
                <td className="py-2 pr-4">{titleCase(String(r.source_status ?? "—"))}</td>
                <td className="py-2 pr-4">
                  <FinStatus value={r.posting_status === "unposted" ? "draft" : r.posting_status} />
                </td>
                <td className="py-2 pr-4 text-muted-foreground">
                  {r.last_error ?? r.required_action}
                </td>
                <td className="py-2 pr-4 text-right">
                  {r.eligible && mayPost ? (
                    <Button
                      size="sm"
                      variant={r.posting_status === "failed" ? "default" : "ghost"}
                      disabled={postOne.isPending}
                      onClick={() =>
                        postOne.mutate({ module: r.source_module, sourceId: r.source_id })
                      }
                    >
                      {r.posting_status === "failed" ? "Retry posting" : "Post"}
                    </Button>
                  ) : (
                    <Link
                      to={r.drill_to}
                      className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                    >
                      Open record
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        </FinanceQueryState>
      </div>

      <p className="text-xs text-muted-foreground">
        Recognised payments appear on the{" "}
        <Link to="/finance/general-ledger" className="underline underline-offset-4">
          general ledger
        </Link>{" "}
        with their journal, and End of Day refuses to close the business day while anything here is
        still blocked or failed.
      </p>
        </TabsContent>
      </Tabs>
    </div>

  );
}
