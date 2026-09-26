/**
 * Performance monitor.
 *
 * What staff actions actually cost on the devices in use, measured from this
 * browser: median, p95 and p99 per action, against the agreed targets, plus
 * how long a committed change takes to reach another screen.
 *
 * The figures are observations, not estimates. Nothing here changes an
 * operational record, and no guest detail, PIN or payment reference is
 * recorded in a span.
 */
import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Activity, Download, Gauge, Radio } from "lucide-react";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { EmptyState, OpsGuard } from "@/components/operations/OpsShared";
import { LiveStatus } from "@/components/common/LiveStatus";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ACTION_TARGET_MS,
  ACTION_TARGET_P99_MS,
  actionSpansCsv,
  getActionSpans,
  onActionSpan,
  percentile,
  summariseActions,
  RELEASE,
  type ActionClass,
  type ActionSpan,
} from "@/lib/perf-telemetry";
import { useRealtimeStatus } from "@/lib/realtime-scope";

export const Route = createFileRoute("/_shell/platform/performance")({
  head: () => ({
    meta: [
      { title: "Performance Monitor — NEØ Hospitality OS" },
      {
        name: "description",
        content:
          "Median, p95 and p99 timings for staff actions, live-update lag and failure rates, measured in the browser.",
      },
      { property: "og:title", content: "Performance Monitor — NEØ Hospitality OS" },
      {
        property: "og:description",
        content: "How long staff actions take, and how quickly committed work reaches other screens.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const CLASS_LABEL: Record<ActionClass, string> = {
  read: "Lookup",
  save: "Save",
  critical: "Money or stock",
  propagation: "Reaches other screens",
};

function ms(value: number): string {
  if (!value) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function Page() {
  const [spans, setSpans] = useState<ActionSpan[]>(() => getActionSpans());
  const [kind, setKind] = useState<"all" | ActionClass>("all");
  const realtime = useRealtimeStatus();

  // Spans arrive as staff work; the screen follows them without re-reading
  // anything from the database.
  useEffect(() => {
    let queued = false;
    return onActionSpan(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        setSpans(getActionSpans());
      }, 500);
    });
  }, []);

  const rows = useMemo(
    () => summariseActions(spans).filter((r) => kind === "all" || r.kind === kind),
    [spans, kind],
  );

  const propagation = useMemo(
    () => spans.filter((s) => s.kind === "propagation" && s.outcome === "ok").map((s) => s.durationMs),
    [spans],
  );

  const failures = spans.filter((s) => s.outcome === "failed" || s.outcome === "timeout").length;
  const breaching = rows.filter((r) => r.breaching).length;

  const figures: SummaryFigure[] = [
    { id: "measured", label: "Actions measured", value: String(spans.length), hint: `Release ${RELEASE}` },
    {
      id: "breaching",
      label: "Above target (p95)",
      value: String(breaching),
      hint: breaching ? "Investigate the slowest first" : "All measured actions within target",
      tone: breaching ? "warning" : "success",
    },
    {
      id: "failures",
      label: "Failures and timeouts",
      value: String(failures),
      hint: "Validation refusals are counted separately",
      tone: failures ? "warning" : "success",
    },
    {
      id: "propagation",
      label: "Change reaches a screen (p95)",
      value: propagation.length ? ms(percentile(propagation, 95)) : "No data yet",
      hint: `Target ${ms(ACTION_TARGET_MS.propagation)} · p99 ${ms(
        ACTION_TARGET_P99_MS.propagation ?? 0,
      )} (measured ${propagation.length ? ms(percentile(propagation, 99)) : "—"})`,
      tone:
        propagation.length && percentile(propagation, 95) > ACTION_TARGET_MS.propagation
          ? "warning"
          : "default",
    },
  ];

  return (
    <OpsGuard path="/platform/performance">
      <PageHeader
        title="Performance Monitor"
        description="Timings recorded in this browser as staff work: how long each action takes to reach a committed result, and how quickly that result appears on other screens."
        icon={Gauge}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <LiveStatus />
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger className="h-9 w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All action types</SelectItem>
                <SelectItem value="read">Lookups</SelectItem>
                <SelectItem value="save">Saves</SelectItem>
                <SelectItem value="critical">Money or stock</SelectItem>
                <SelectItem value="propagation">Reaches other screens</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={spans.length === 0}
              onClick={() =>
                download(`neo-performance-${new Date().toISOString().slice(0, 10)}.csv`, actionSpansCsv(spans))
              }
            >
              <Download className="mr-2 size-4" />
              Export measurements
            </Button>
          </div>
        }
      />

      <SummaryStrip lead={figures[0]!} figures={figures.slice(1)} />

      <SectionCard
        title="Slowest actions"
        description="Sorted by p95 — the time 95 out of 100 attempts finished within. Only successful attempts are timed against the target."
        icon={Activity}
      >
        {rows.length === 0 ? (
          <EmptyState
            title="No measurements yet"
            description="Figures appear as staff use the system in this browser session. Work a few screens, then return here."
          />
        ) : (
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Samples</TableHead>
                  <TableHead className="text-right">Median</TableHead>
                  <TableHead className="text-right">p95</TableHead>
                  <TableHead className="text-right">p99</TableHead>
                  <TableHead className="text-right">Worst</TableHead>
                  <TableHead className="text-right">Refused</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead>Against target</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.action}>
                    <TableCell className="font-medium">{r.action}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {CLASS_LABEL[r.kind]}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.samples}</TableCell>
                    <TableCell className="text-right tabular-nums">{ms(r.p50)}</TableCell>
                    <TableCell className="text-right tabular-nums">{ms(r.p95)}</TableCell>
                    <TableCell className="text-right tabular-nums">{ms(r.p99)}</TableCell>
                    <TableCell className="text-right tabular-nums">{ms(r.worst)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.rejections || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.failures + r.timeouts || "—"}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={r.breaching ? "warning" : "success"}>
                        {r.breaching ? `Over ${ms(r.targetMs)}` : `Within ${ms(r.targetMs)}`}
                      </StatusPill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        )}
      </SectionCard>

      <SectionCard
        title="Live updates"
        description="Whether this screen is receiving committed changes, and how long they take to arrive."
        icon={Radio}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs uppercase text-muted-foreground">Connection</p>
            <p className="mt-1 text-sm font-medium">
              {realtime.connection === "live"
                ? "Receiving changes"
                : realtime.connection === "reconnecting"
                  ? `Reconnecting (attempt ${realtime.attempts})`
                  : realtime.connection === "connecting"
                    ? "Connecting"
                    : "No screen on this tab is subscribed"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Median arrival</p>
            <p className="mt-1 text-sm font-medium tabular-nums">
              {propagation.length ? ms(percentile(propagation, 50)) : "No data yet"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Changes observed</p>
            <p className="mt-1 text-sm font-medium tabular-nums">{propagation.length}</p>
          </div>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Arrival is measured from the database commit to this screen updating, so it includes the
          network path a member of staff actually has. External providers — M-Pesa, SMS, banks — are
          measured separately and are never counted inside these figures.
        </p>
      </SectionCard>
    </OpsGuard>
  );
}
