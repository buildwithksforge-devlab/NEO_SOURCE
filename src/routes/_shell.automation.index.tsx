import { useMemo, useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Mail,
  PlayCircle,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  AXIS_PROPS,
  BAR_PROPS,
  GRID_PROPS,
  TOOLTIP_PROPS,
  chartSeriesColor,
} from "@/components/charts/ChartKit";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import {
  statusTone,
  titleCase,
  useCommunicationQueue,
  useDomainEvents,
  useEscalationEvents,
  useWorkflowFailures,
  useWorkflowRuns,
  useWorkflows,
  useAutomationRefresh,
} from "@/lib/automation";
import { generateAiBrief, getOutboundReleaseStatus, runAutomationEngine } from "@/lib/automation.functions";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/automation/")({
  head: () => ({
    meta: [
      { title: "Automation Dashboard — NEØ" },
      {
        name: "description",
        content:
          "Live view of workflow runs, queued guest communications, automated tasks, escalations and provider health.",
      },
      { property: "og:title", content: "Automation Dashboard — NEØ" },
      {
        property: "og:description",
        content: "Workflow, communication and escalation monitoring for hotel operations.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Brief = Awaited<ReturnType<typeof generateAiBrief>>;

function AutomationDashboard() {
  const { can, isAdmin } = useAuth();
  const refresh = useAutomationRefresh();
  const workflows = useWorkflows();
  const runs = useWorkflowRuns(100);
  const events = useDomainEvents(200);
  const queue = useCommunicationQueue();
  const failures = useWorkflowFailures();
  const escalations = useEscalationEvents();
  const runEngine = useServerFn(runAutomationEngine);
  const loadOutboundStatus = useServerFn(getOutboundReleaseStatus);
  const outboundStatus = useQuery({ queryKey: ["outbound-release-status"], queryFn: () => loadOutboundStatus() });
  const aiBrief = useServerFn(generateAiBrief);
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState<Brief | null>(null);

  const canRun = can("automation", "edit");

  const rows = runs.data ?? [];
  const today = new Date().toDateString();
  const runsToday = rows.filter((r) => new Date(r.started_at as string).toDateString() === today);
  const messages = queue.data ?? [];

  const channelData = useMemo(() => {
    const map = new Map<
      string,
      { channel: string; queued: number; sent: number; failed: number; suppressed: number }
    >();
    for (const m of messages) {
      const key = m.channel as string;
      const entry = map.get(key) ?? {
        channel: titleCase(key),
        queued: 0,
        sent: 0,
        failed: 0,
        suppressed: 0,
      };
      if (m.status === "sent" || m.status === "delivered") entry.sent += 1;
      else if (m.status === "failed") entry.failed += 1;
      else if (m.status === "suppressed") entry.suppressed += 1;
      else entry.queued += 1;
      map.set(key, entry);
    }
    return Array.from(map.values());
  }, [messages]);

  async function handleRun() {
    setBusy(true);
    try {
      const report = await runEngine({});
      toast.success(`Processed ${report.eventsProcessed} event(s) · ${report.runsCreated} workflow run(s) · ${report.actionsCompleted} action(s)`);
      if (report.queue.disabled) toast.warning("Outbound messages remain on hold pending backlog review and provider setup.");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Engine run failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleBrief() {
    try {
      setBrief(await aiBrief({}));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI request failed");
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Automation & Communications"
        title="Automation dashboard"
        description="Every figure below comes from real recorded events, workflow runs and queued communications. Nothing is simulated."
        actions={
          canRun ? (
            <Button onClick={handleRun} disabled={busy}>
              <PlayCircle className="size-4" /> {busy ? "Processing…" : "Process pending events"}
            </Button>
          ) : null
        }
      />

      {outboundStatus.data && !outboundStatus.data.enabled ? (
        <p role="status" className="mb-6 rounded-xl border border-border bg-muted p-4 text-sm text-foreground">
          Outbound delivery is on hold. Queued emails and texts have not been sent. Review historical messages and configure a release cutoff before enabling dispatch.
        </p>
      ) : null}

      <div className="neo-kpi-grid mb-6">
        <StatCard
          lead
          label="Active workflows"
          value={String((workflows.data ?? []).filter((w) => w.status === "active").length)}
          icon={Workflow}
        />
        <StatCard
          label="Paused workflows"
          value={String((workflows.data ?? []).filter((w) => w.status === "paused").length)}
          icon={Workflow}
          tone="warning"
        />
        <StatCard label="Runs today" value={String(runsToday.length)} icon={Activity} />
        <StatCard
          label="Successful runs today"
          value={String(runsToday.filter((r) => r.status === "completed").length)}
          icon={CheckCircle2}
          tone="success"
        />
        <StatCard
          label="Pending events"
          value={String((events.data ?? []).filter((e) => e.status === "pending").length)}
          icon={Activity}
        />
        <StatCard
          label="Messages queued"
          value={String(messages.filter((m) => m.status === "queued").length)}
          icon={Mail}
        />
        <StatCard
          label="Messages suppressed"
          value={String(messages.filter((m) => m.status === "suppressed").length)}
          icon={Mail}
          tone="warning"
        />
        <StatCard
          label="Open workflow failures"
          value={String((failures.data ?? []).filter((f) => f.status === "new").length)}
          icon={AlertTriangle}
          tone="warning"
        />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <SectionCard title="Communication by channel" description="Real queue records only.">
          {queue.isLoading ? (
            <LoadingState variant="cards" rows={2} />
          ) : channelData.length === 0 ? (
            <EmptyState inline title="No communications queued" description="No communications have been queued yet." />
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={channelData}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis dataKey="channel" {...AXIS_PROPS} />
                  <YAxis allowDecimals={false} {...AXIS_PROPS} />
                  <Tooltip {...TOOLTIP_PROPS} />
                  <Bar {...BAR_PROPS} dataKey="queued" fill={chartSeriesColor(0)} />
                  <Bar {...BAR_PROPS} dataKey="sent" fill={chartSeriesColor(1)} />
                  <Bar {...BAR_PROPS} dataKey="failed" fill={chartSeriesColor(2)} />
                  <Bar {...BAR_PROPS} dataKey="suppressed" fill={chartSeriesColor(3)} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="AI smart notifications"
          description="Summaries are produced only from recorded tenant figures."
          actions={
            <Button variant="outline" size="sm" onClick={handleBrief}>
              <Bot className="size-4" /> Generate brief
            </Button>
          }
        >
          {!brief ? (
            <EmptyState
              inline
              title="No brief generated yet"
              description="Generate a management brief from the last seven days of recorded automation activity."
            />
          ) : !brief.configured ? (
            <div className="space-y-3">
              <StatusPill tone="warning">AI Smart Notifications — Unavailable</StatusPill>
              <p className="text-sm text-muted-foreground">
                {brief.reason ?? "No summary can be produced right now."} The underlying figures for
                the period are shown below.
              </p>
              <ul className="grid gap-1 text-sm sm:grid-cols-2">
                {Object.entries(brief.facts)
                  .filter(([k]) => k !== "period")
                  .map(([k, v]) => (
                    <li
                      key={k}
                      className="flex justify-between rounded-md border border-border px-3 py-1.5"
                    >
                      <span className="text-muted-foreground">{titleCase(k)}</span>
                      <span className="font-medium">{String(v)}</span>
                    </li>
                  ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-2">
              <StatusPill tone="info">AI generated</StatusPill>
              <p className="whitespace-pre-wrap text-sm">{brief.summary}</p>
              <p className="text-xs text-muted-foreground">
                Generated {new Date(brief.generatedAt).toLocaleString()} · period{" "}
                {new Date(brief.facts.period.from).toLocaleDateString()} –{" "}
                {new Date(brief.facts.period.to).toLocaleDateString()}
              </p>
            </div>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Recent workflow runs">
          {runs.isLoading ? (
            <LoadingState rows={3} />
          ) : rows.length === 0 ? (
            <EmptyState inline title="No workflow runs" description="No workflow has run yet." />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {rows.slice(0, 10).map((r) => (
                <li key={r.id as string} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <p className="font-medium">
                      {(r as unknown as { workflow_definitions: { name: string } | null })
                        .workflow_definitions?.name ?? "Workflow"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(r.started_at as string).toLocaleString()} · v{r.workflow_version} ·{" "}
                      {r.mode}
                    </p>
                  </div>
                  <StatusPill tone={statusTone(r.status as string)}>
                    {titleCase(r.status as string)}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Overdue escalations">
          {escalations.isLoading ? (
            <LoadingState rows={3} />
          ) : (escalations.data ?? []).length === 0 ? (
            <EmptyState inline title="No escalations raised" description="No escalations have been raised." />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {(escalations.data ?? []).slice(0, 10).map((e) => (
                <li key={e.id as string} className="py-2">
                  <p className="font-medium">{e.reason as string}</p>
                  <p className="text-xs text-muted-foreground">
                    {titleCase(e.subject_type as string)} · level {e.level} ·{" "}
                    {new Date(e.created_at as string).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/automation">
      <AutomationDashboard />
    </OpsGuard>
  );
}
