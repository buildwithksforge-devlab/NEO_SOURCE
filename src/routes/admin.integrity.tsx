import { useState } from "react";
import { LoadingState } from "@/components/common/StateSystem";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { Badge } from "@/components/ui/badge";
import { RpcHealthPanel } from "@/components/admin/RpcHealthPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  guardLabels,
  useFinaliseLifecycles,
  useGuardViolations,
  useIntegrityRuns,
  useLifecycleAudit,
  useLifecycleRepairs,
  useReviewGuardViolation,
  useRunIntegrityChecks,
  useRunStructureScan,
  type GuardViolation,
  type IntegrityRun,
  type LifecycleModule,
  type LifecycleRepair,
} from "@/lib/guard-violations";
import {
  auditGapReason,
  notificationVerdict,
  sortNotificationRows,
  useAuditCompleteness,
  useNotificationIntegrity,
  type AuditCompletenessRow,
  type NotificationIntegrityRow,
} from "@/lib/inspection";

export const Route = createFileRoute("/admin/integrity")({
  head: () => ({
    meta: [
      { title: "Operational Integrity — NEØ Administration" },
      {
        name: "description",
        content:
          "Review blocked laundry and restaurant order writes, every lifecycle repair with before and after state, and the results of the scheduled integrity checks.",
      },
      { property: "og:title", content: "Operational Integrity — NEØ Administration" },
      {
        property: "og:description",
        content: "Guard violation inbox, lifecycle repair audit trail and scheduled integrity proofs.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: IntegrityPage,
});

const fmt = (v: string) => new Date(v).toLocaleString();

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <pre className="max-w-[22rem] overflow-x-auto rounded bg-muted/50 p-2 text-[11px] leading-tight">
      {JSON.stringify(value, null, 1)}
    </pre>
  );
}

function ViolationRow({ row }: { row: GuardViolation }) {
  const review = useReviewGuardViolation();
  const [note, setNote] = useState("");
  return (
    <TableRow>
      <TableCell className="align-top">
        <span className="block text-sm font-medium">{guardLabels[row.guard_name] ?? row.guard_name}</span>
        <span className="block text-xs text-muted-foreground">{row.source_table} · {row.operation}</span>
        <span className="block text-xs text-muted-foreground">{fmt(row.created_at)}</span>
      </TableCell>
      <TableCell className="align-top">
        <span className="block text-sm">{row.record_label ?? row.record_id ?? "—"}</span>
        <span className="block text-xs text-muted-foreground">{row.actor_name ?? "Unknown user"}</span>
      </TableCell>
      <TableCell className="align-top text-sm">{row.reason}</TableCell>
      <TableCell className="align-top"><Json value={row.attempted_payload} /></TableCell>
      <TableCell className="align-top">
        {row.status === "reviewed" ? (
          <>
            <Badge variant="secondary">Reviewed</Badge>
            <span className="mt-1 block text-xs text-muted-foreground">{row.review_note ?? ""}</span>
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Review note"
              className="h-8 text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={review.isPending}
              onClick={() => review.mutate({ id: row.id, note })}
            >
              Mark reviewed
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function RepairRow({ row }: { row: LifecycleRepair }) {
  return (
    <TableRow>
      <TableCell className="align-top">
        <span className="block text-sm font-medium">{row.action}</span>
        <span className="block text-xs text-muted-foreground">{fmt(row.created_at)}</span>
        <span className="block text-xs text-muted-foreground">{row.actor_name ?? "System"}</span>
      </TableCell>
      <TableCell className="align-top">
        <span className="block font-mono text-[11px]">{row.record_id ?? "—"}</span>
        <span className="block text-xs text-muted-foreground">{row.module ?? "—"}</span>
      </TableCell>
      <TableCell className="align-top"><Json value={row.previous_value} /></TableCell>
      <TableCell className="align-top"><Json value={row.new_value} /></TableCell>
      <TableCell className="align-top">
        <Badge variant="outline" className="font-mono text-[11px]">{row.guard_rule}</Badge>
        {row.reason ? <span className="mt-1 block text-xs text-muted-foreground">{row.reason}</span> : null}
      </TableCell>
    </TableRow>
  );
}

function RunRow({ row }: { row: IntegrityRun }) {
  return (
    <TableRow>
      <TableCell className="align-top">
        <span className="block text-sm font-medium">{row.check_label}</span>
        <span className="block text-xs text-muted-foreground">{fmt(row.run_at)} · {row.triggered_by}</span>
      </TableCell>
      <TableCell className="align-top">
        <Badge variant={row.status === "clean" ? "secondary" : "destructive"}>
          {row.status === "clean" ? "Clean" : `${row.anomaly_count} anomalies`}
        </Badge>
      </TableCell>
      <TableCell className="align-top">
        {row.anomaly_count > 0 ? <Json value={row.details} /> : <span className="text-xs text-muted-foreground">No offending records</span>}
      </TableCell>
    </TableRow>
  );
}

function LifecycleRow({ row }: { row: LifecycleModule }) {
  return (
    <TableRow>
      <TableCell className="align-top">
        <span className="block text-sm font-medium">{row.label}</span>
        <span className="block text-xs text-muted-foreground">{row.detail}</span>
      </TableCell>
      <TableCell className="align-top text-sm tabular-nums">{row.complete} / {row.total}</TableCell>
      <TableCell className="align-top text-sm tabular-nums">{row.in_flight}</TableCell>
      <TableCell className="align-top">
        <Badge variant={row.status === "attention" ? "destructive" : "secondary"}>
          {row.status === "unknown" ? "No records" : row.incomplete === 0 ? "Complete" : `${row.incomplete} unfinished`}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

function AuditRow({ row }: { row: AuditCompletenessRow }) {
  const reason = auditGapReason(row);
  return (
    <TableRow>
      <TableCell className="align-top">
        <span className="block text-sm font-medium">{row.label}</span>
        <span className="block text-xs text-muted-foreground">Next step: {row.handoff_label}</span>
      </TableCell>
      <TableCell className="align-top text-sm tabular-nums">{row.total}</TableCell>
      <TableCell className="align-top text-sm tabular-nums">
        {row.with_actor} / {row.total}
      </TableCell>
      <TableCell className="align-top text-sm tabular-nums">
        {row.with_trail} / {row.total}
      </TableCell>
      <TableCell className="align-top text-sm tabular-nums">
        {row.approval_required ? `${row.with_approval} / ${row.total}` : "Not required"}
      </TableCell>
      <TableCell className="align-top text-sm tabular-nums">
        {row.handoff_ok} / {row.total}
      </TableCell>
      <TableCell className="align-top">
        <Badge
          variant={
            row.status === "attention" ? "destructive" : row.status === "partial" ? "outline" : "secondary"
          }
        >
          {row.status === "unknown"
            ? "No records"
            : row.status === "ready"
              ? "Fully traceable"
              : row.status === "partial"
                ? "History incomplete"
                : "Attention"}
        </Badge>
        {reason ? <span className="mt-1 block text-xs text-muted-foreground">{reason}</span> : null}
      </TableCell>
    </TableRow>
  );
}

function NotificationRow({ row }: { row: NotificationIntegrityRow }) {
  const tone =
    row.status === "missing-alerts" || row.status === "spam"
      ? "destructive"
      : row.status === "ok"
        ? "secondary"
        : "outline";
  const labels: Record<NotificationIntegrityRow["status"], string> = {
    "missing-alerts": "Nobody informed",
    spam: "Notification spam",
    unattended: "Unattended",
    unconfigured: "No routing rule",
    ok: "Correctly notified",
    unknown: "Awaiting data",
  };
  return (
    <TableRow>
      <TableCell className="align-top">
        <span className="block font-mono text-[11px]">{row.event_type}</span>
        <span className="block text-xs text-muted-foreground">{notificationVerdict(row)}</span>
      </TableCell>
      <TableCell className="align-top text-sm tabular-nums">{row.triggers}</TableCell>
      <TableCell className="align-top text-sm tabular-nums">
        {row.covered} / {row.triggers}
      </TableCell>
      <TableCell className="align-top text-sm tabular-nums">{row.recipients}</TableCell>
      <TableCell className="align-top text-sm tabular-nums">{row.fanout_max}</TableCell>
      <TableCell className="align-top text-sm tabular-nums">{row.duplicates}</TableCell>
      <TableCell className="align-top">
        <Badge variant={tone}>{labels[row.status]}</Badge>
      </TableCell>
    </TableRow>
  );
}

function IntegrityPage() {
  const violations = useGuardViolations("all");
  const repairs = useLifecycleRepairs();
  const runs = useIntegrityRuns();
  const runNow = useRunIntegrityChecks();
  const structureScan = useRunStructureScan();
  const lifecycle = useLifecycleAudit();
  const finalise = useFinaliseLifecycles();
  const auditTrail = useAuditCompleteness();
  const notifications = useNotificationIntegrity(30);

  const openCount = (violations.data ?? []).filter((v) => v.status !== "reviewed").length;
  const latestAnomalies = (runs.data ?? []).slice(0, 2).reduce((s, r) => s + r.anomaly_count, 0);
  const unfinished = lifecycle.data?.incomplete ?? 0;
  const auditGaps = auditTrail.data?.gaps ?? 0;
  const missingAlerts = notifications.data?.missing ?? 0;
  const spamEvents = notifications.data?.spam ?? 0;
  const notificationRows = sortNotificationRows(notifications.data?.events ?? []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operational Integrity"
        description="Every write the lifecycle guards refused, every correction that was applied, whether each transaction can account for itself, whether the right person was informed, and the results of the nightly integrity proofs."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => structureScan.mutate()}
              disabled={structureScan.isPending}
            >
              {structureScan.isPending ? "Checking…" : "Check structure & relationships"}
            </Button>
            <Button
              variant="outline"
              onClick={() => finalise.mutate()}
              disabled={finalise.isPending}
            >
              {finalise.isPending ? "Finalising…" : "Finalise completed work"}
            </Button>
            <Button onClick={() => runNow.mutate()} disabled={runNow.isPending}>
              {runNow.isPending ? "Running…" : "Run checks now"}
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Open guard violations" value={String(openCount)} />
        <StatCard label="Unfinished operations" value={String(unfinished)} />
        <StatCard label="History gaps" value={String(auditGaps)} />
        <StatCard label="Events nobody was told about" value={String(missingAlerts)} />
        <StatCard label="Over-notified events" value={String(spamEvents)} />
        <StatCard label="Anomalies in latest run" value={String(latestAnomalies)} />
      </div>

      <Tabs defaultValue="lifecycle">
        <TabsList>
          <TabsTrigger value="lifecycle">Lifecycle completion</TabsTrigger>
          <TabsTrigger value="audit">Transaction history</TabsTrigger>
          <TabsTrigger value="notifications">Notifications & escalation</TabsTrigger>
          <TabsTrigger value="violations">Guard violation inbox</TabsTrigger>
          <TabsTrigger value="repairs">Lifecycle repair trail</TabsTrigger>
          <TabsTrigger value="checks">Scheduled checks</TabsTrigger>
          <TabsTrigger value="rpc">Routine calls</TabsTrigger>
        </TabsList>

        <TabsContent value="lifecycle">
          <SectionCard
            title="Does every operation reach its end state?"
            description="Reservation, folio, sale, kitchen ticket, cleaning job, laundry, delivery, event, requisition, purchase, payment, journal, guest feedback, offboarding, repair, campaign, approval and journey — counted against the property you are viewing. “Finalise completed work” only posts or timestamps what is already finished; anything needing a decision stays here."
          >
            {lifecycle.isLoading ? (
              <LoadingState variant="rows" rows={3} />
            ) : (lifecycle.data?.modules ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Awaiting data.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lifecycle</TableHead>
                    <TableHead>Finished</TableHead>
                    <TableHead>In progress</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(lifecycle.data?.modules ?? []).map((row) => (
                    <LifecycleRow key={row.module} row={row} />
                  ))}
                </TableBody>
              </Table>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="audit">
          <SectionCard
            title="Can every transaction account for itself?"
            description="For each transaction family: how many records name the person who created them, carry a recorded change history, hold an approval where one is required, and completed the next step downstream. Counted against the property you are viewing — a gap here is a real record, never an estimate."
          >
            {auditTrail.isLoading ? (
              <LoadingState variant="rows" rows={3} />
            ) : (auditTrail.data?.transactions ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Awaiting data.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Transaction</TableHead>
                      <TableHead>Records</TableHead>
                      <TableHead>Created by known</TableHead>
                      <TableHead>Change history</TableHead>
                      <TableHead>Approval</TableHead>
                      <TableHead>Handoff done</TableHead>
                      <TableHead>State</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(auditTrail.data?.transactions ?? []).map((row) => (
                      <AuditRow key={row.module} row={row} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="notifications">
          <SectionCard
            title="Was the right person actually informed?"
            description={`Each workflow event over the last ${notifications.data?.window_days ?? 30} days: how many times it happened, how many occurrences reached a notified recipient, how many distinct people were told, the widest fanout for a single occurrence and any duplicate notices. Two failures are separated deliberately — a missing critical alert, and notification spam (more than ${notifications.data?.fanout_limit ?? 12} recipients for one occurrence, or the same notice twice to one reader). ${notifications.data ? `${notifications.data.escalations_open} escalation${notifications.data.escalations_open === 1 ? "" : "s"} open, ${notifications.data.escalations_unacknowledged} unacknowledged.` : ""}`}
          >
            {notifications.isLoading ? (
              <LoadingState variant="rows" rows={3} />
            ) : notificationRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Awaiting data.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead>Occurred</TableHead>
                      <TableHead>Notified</TableHead>
                      <TableHead>People told</TableHead>
                      <TableHead>Widest fanout</TableHead>
                      <TableHead>Duplicates</TableHead>
                      <TableHead>State</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {notificationRows.map((row) => (
                      <NotificationRow key={row.event_type} row={row} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </TabsContent>


        <TabsContent value="violations">
          <SectionCard
            title="Blocked writes awaiting review"
            description="Recorded when the laundry or restaurant order guards refuse a change. The refusal itself is enforced in the database; this is the readable record of what was attempted and why it was stopped."
          >
            {violations.isLoading ? (
              <LoadingState variant="rows" rows={3} />
            ) : (violations.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No blocked writes have been recorded.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Guard</TableHead>
                    <TableHead>Record & user</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Attempted values</TableHead>
                    <TableHead>Review</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(violations.data ?? []).map((row) => (
                    <ViolationRow key={row.id} row={row} />
                  ))}
                </TableBody>
              </Table>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="repairs">
          <SectionCard
            title="Lifecycle repairs"
            description="Every recorded correction — including pos.lifecycle.repair — with the state before and after and the guard rule that made the correction necessary."
          >
            {repairs.isLoading ? (
              <LoadingState variant="rows" rows={3} />
            ) : (repairs.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No lifecycle repairs recorded.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Action</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Before</TableHead>
                    <TableHead>After</TableHead>
                    <TableHead>Guard rule</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(repairs.data ?? []).map((row) => (
                    <RepairRow key={row.id} row={row} />
                  ))}
                </TableBody>
              </Table>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="checks">
          <SectionCard
            title="Scheduled integrity proofs"
            description="Runs automatically every night at 02:15. Any anomaly notifies organisation-wide users and raises an alert on the owner dashboard."
          >
            {runs.isLoading ? (
              <LoadingState variant="rows" rows={3} />
            ) : (runs.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No checks have run yet. Use “Run checks now”.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Check</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Offending records</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(runs.data ?? []).map((row) => (
                    <RunRow key={row.id} row={row} />
                  ))}
                </TableBody>
              </Table>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="rpc">
          <RpcHealthPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
