/**
 * Manual handoff replay.
 *
 * Operational events reach Finance through an outbox. Anything that exhausted
 * its automatic attempts waits here. Replay is safe to press twice: the event
 * is requeued under an advisory lock, and the posting it drives refuses a
 * second journal for a record that already has one.
 */
import { useState } from "react";
import { LoadingState } from "@/components/common/StateSystem";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FinanceEmpty, FinanceGuard, financeHead } from "@/components/finance/FinanceShared";
import { PostingPlanDialog, type PostingPlanTarget } from "@/components/finance/PostingPlanDialog";
import { useFinanceFactScope } from "@/lib/finance-data";
import { useOutboxReplay, useOutboxReplayBatch, usePostingReceipts } from "@/lib/finance-posting";
import { useOutboxFailures, useOutboxHealth } from "@/lib/intelligence-data";

export const Route = createFileRoute("/_shell/finance/outbox")({
  head: financeHead(
    "Handoff replay & outbox health",
    "Retry failed operational-to-Finance handoffs with idempotent safety, and read the posting receipt and failure reason behind each one.",
  ),
  component: () => (
    <FinanceGuard feature="reconciliation" action="edit">
      <OutboxReplay />
    </FinanceGuard>
  ),
});

function OutboxReplay() {
  const scope = useFinanceFactScope();
  const health = useOutboxHealth(scope.branchId);
  const failures = useOutboxFailures(scope.branchId, 100);
  const receipts = usePostingReceipts(scope);
  const replay = useOutboxReplay();
  const replayBatch = useOutboxReplayBatch();
  const [reason, setReason] = useState("");
  const [plan, setPlan] = useState<PostingPlanTarget | null>(null);

  const rows = failures.data ?? [];
  const receiptFor = (sourceId: string | null) =>
    sourceId ? (receipts.data ?? []).find((r) => r.source_id === sourceId) : undefined;

  const stat = (v: number | null | undefined) =>
    health.isLoading ? "…" : v === null || v === undefined ? "—" : String(v);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Handoff replay"
        description="Every operational event that failed to reach Finance, with its failure reason, attempt count and posting receipt. Replaying a handoff that already succeeded reports it instead of repeating it."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                void failures.refetch();
                void health.refetch();
                void receipts.refetch();
              }}
            >
              <RefreshCw className="mr-2 size-4" /> Refresh
            </Button>
            <Button
              disabled={rows.length === 0 || replayBatch.isPending}
              onClick={() =>
                replayBatch.mutate({
                  branchId: scope.branchId,
                  limit: 25,
                  reason: reason.trim() || null,
                })
              }
            >
              <RotateCcw className="mr-2 size-4" /> Replay next {Math.min(rows.length, 25)}
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Awaiting replay"
          value={failures.isLoading ? "…" : String(rows.length)}
          icon={AlertTriangle}
          tone="warning"
          hint="Failed or dead-lettered handoffs"
        />
        <StatCard
          label="Pending"
          value={stat(health.data?.pending)}
          icon={RefreshCw}
          hint="Queued for the next automatic attempt"
        />
        <StatCard
          label="Retrying"
          value={stat(health.data?.retrying)}
          icon={RotateCcw}
          hint="Backing off between attempts"
        />
        <StatCard
          label="Processed (24h)"
          value={stat(health.data?.processed_24h)}
          icon={RefreshCw}
          tone="success"
          hint="Handoffs that completed"
        />
      </div>

      <SectionCard
        title="Replay reason"
        description="Recorded on the audit trail with every replay. Optional, but it is what explains the retry later."
      >
        <div className="max-w-xl">
          <Label className="mb-1 block text-xs">Reason</Label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. supplier account added to the chart of accounts"
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Failed handoffs"
        description="Each row shows why the handoff stopped and what the last posting attempt recorded."
      >
        {failures.isLoading ? (
          <LoadingState variant="cards" rows={3} />
        ) : failures.error ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="size-4" /> The outbox could not be read, so no counts are
            shown.
          </p>
        ) : rows.length === 0 ? (
          <FinanceEmpty
            title="No handoff is waiting"
            description="Every operational event in this property reached its destination."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[0.68rem] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Event</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Attempts</th>
                  <th className="py-2 pr-3">Occurred</th>
                  <th className="py-2 pr-3">Failure reason</th>
                  <th className="py-2 pr-3">Posting receipt</th>
                  <th className="py-2 pr-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const receipt = receiptFor(r.source_record_id);
                  return (
                    <tr key={r.id}>
                      <td className="py-2 pr-3">
                        <span className="font-medium">{r.event_type}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {r.source_module ?? "—"}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <StatusPill tone={r.dead_lettered_at ? "destructive" : "warning"}>
                          {r.dead_lettered_at ? "dead-lettered" : r.status}
                        </StatusPill>
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {r.attempts}
                        {r.max_attempts ? ` / ${r.max_attempts}` : ""}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {new Date(r.occurred_at).toLocaleString()}
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {r.last_error || "No error text was recorded."}
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {receipt ? (
                          <>
                            <StatusPill
                              tone={
                                receipt.status === "posted"
                                  ? "success"
                                  : receipt.status === "failed"
                                    ? "destructive"
                                    : "warning"
                              }
                            >
                              {receipt.status}
                            </StatusPill>
                            <span className="ml-2 text-muted-foreground">
                              {receipt.detail ||
                                receipt.last_error ||
                                `${receipt.attempts} attempt(s)`}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">No receipt yet</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          {r.source_module && r.source_record_id ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setPlan({
                                  module: r.source_module as string,
                                  sourceId: r.source_record_id as string,
                                  reference: r.event_type,
                                })
                              }
                            >
                              Explain
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            disabled={replay.isPending}
                            onClick={() =>
                              replay.mutate({ eventId: r.id, reason: reason.trim() || null })
                            }
                          >
                            Replay
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <PostingPlanDialog target={plan} onClose={() => setPlan(null)} />
    </div>
  );
}
