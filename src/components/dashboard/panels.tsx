import { Link } from "@tanstack/react-router";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle, Bell, ClipboardList, Sparkles } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { EmptyState } from "./AwaitingData";
import { titleize } from "@/lib/permissions";
import type { DashboardScope } from "@/lib/dashboard-data";
import {
  useDashboardAlerts,
  useDashboardMetrics,
  useDashboardNotifications,
  useDepartmentWorkload,
  useKpiDefinitions,
  useMyTasks,
  usePendingApprovals,
  useRecentActivity,
  useStationWorkload,
  useTasksTrend,
  useTeamTasks,
} from "@/lib/dashboard-data";
import { readMetric, type PanelKey } from "@/lib/dashboards";
import { PermittedLink } from "@/components/common/PermittedLink";

import {
  AXIS_PROPS,
  ChartCard,
  GRID_PROPS,
  TOOLTIP_PROPS,
  chartSeriesColor,
  ChartGradients,
  chartFill,
  LINE_PROPS,
  BAR_PROPS,
} from "@/components/charts/ChartKit";

const priorityTone = (p: string) =>
  p === "urgent" || p === "high" ? "warning" : p === "low" ? "default" : "info";

const relative = (iso: string | null) => {
  if (!iso) return "No due date";
  const diff = new Date(iso).getTime() - Date.now();
  const hours = Math.round(diff / 3_600_000);
  if (Math.abs(hours) < 24) return hours >= 0 ? `Due in ${hours} h` : `Overdue by ${-hours} h`;
  const days = Math.round(hours / 24);
  return days >= 0 ? `Due in ${days} d` : `Overdue by ${-days} d`;
};

function TaskList({
  tasks,
  emptyMessage,
}: {
  tasks: { id: string; reference: string; title: string; status: string; priority: string; due_at: string | null; progress: number }[];
  emptyMessage: string;
}) {
  if (!tasks.length) return <EmptyState message={emptyMessage} to="/tasks" cta="Open tasks" />;
  return (
    <ul className="space-y-3">
      {tasks.map((t) => (
        <li key={t.id} className="rounded-xl border border-border p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{t.title}</p>
              <p className="text-xs text-muted-foreground">
                {t.reference} · {relative(t.due_at)}
              </p>
            </div>
            <StatusPill tone={priorityTone(t.priority)}>{titleize(t.priority)}</StatusPill>
          </div>
          <Progress value={t.progress} className="mt-2 h-1.5" />
        </li>
      ))}
    </ul>
  );
}

/**
 * A panel that could not be read says so. It never falls back to the empty
 * state, which would claim there are no records when the source failed.
 */
function PanelError({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <SectionCard title={title} description="The source could not be read">
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        <p className="flex items-center gap-2 font-medium">
          <AlertTriangle className="size-4" />
          Query failed
        </p>
        <p className="mt-1 text-xs text-destructive/80">
          Retry, or report the problem if it persists.
        </p>
        <Button size="sm" variant="outline" className="mt-3 h-7 px-2 text-xs" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </SectionCard>
  );
}

/** Loading is a state of its own — never an empty list. */
function PanelLoading({ title }: { title: string }) {
  return (
    <SectionCard title={title} description="Reading the operational source">
      <div className="space-y-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-xl bg-muted/60" />
        ))}
      </div>
    </SectionCard>
  );
}


export function DashboardPanel({
  panel,
  title,
  scope,
  userId,
}: {
  panel: PanelKey;
  title: string;
  scope: DashboardScope;
  userId: string | null;
}) {
  switch (panel) {
    case "my-tasks":
      return <MyTasksPanel title={title} scope={scope} userId={userId} />;
    case "team-tasks":
      return <TeamTasksPanel title={title} scope={scope} />;
    case "approvals":
      return <ApprovalsPanel title={title} scope={scope} />;
    case "notifications":
      return <NotificationsPanel title={title} scope={scope} />;
    case "alerts":
      return <AlertsPanel title={title} scope={scope} />;
    case "activity":
      return <ActivityPanel title={title} scope={scope} />;
    case "task-trend":
      return <TaskTrendPanel title={title} scope={scope} />;
    case "department-workload":
      return <DepartmentWorkloadPanel title={title} />;
    case "station-workload":
      return <StationWorkloadPanel title={title} />;
    case "kpi-catalogue":
      return <KpiCataloguePanel title={title} />;
    case "ai-summary":
      return <AiSummaryPanel title={title} scope={scope} />;
    default:
      return null;
  }
}

function MyTasksPanel({
  title,
  scope,
  userId,
}: {
  title: string;
  scope: DashboardScope;
  userId: string | null;
}) {
  const q = useMyTasks(userId, scope);
  if (q.error) return <PanelError title={title} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <PanelLoading title={title} />;
  return (
    <SectionCard
      title={title}
      description="Assigned to you and still open"
      actions={
        <Button variant="ghost" size="sm" asChild>
          <PermittedLink to="/tasks" hideWhenDenied>View all</PermittedLink>
        </Button>
      }
    >
      <TaskList tasks={q.data ?? []} emptyMessage="No open tasks assigned to you." />
    </SectionCard>
  );
}

function TeamTasksPanel({ title, scope }: { title: string; scope: DashboardScope }) {
  const q = useTeamTasks(scope);
  if (q.error) return <PanelError title={title} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <PanelLoading title={title} />;
  return (
    <SectionCard
      title={title}
      description="Open work in your scope, soonest due first"
      actions={
        <Button variant="ghost" size="sm" asChild>
          <PermittedLink to="/tasks" hideWhenDenied>Manage</PermittedLink>
        </Button>
      }
    >
      <TaskList tasks={q.data ?? []} emptyMessage="No open tasks in this scope." />
    </SectionCard>
  );
}

function ApprovalsPanel({ title, scope }: { title: string; scope: DashboardScope }) {
  const q = usePendingApprovals(scope);
  const rows = q.data ?? [];
  if (q.error) return <PanelError title={title} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <PanelLoading title={title} />;
  return (
    <SectionCard
      className="neo-accent-edge"
      title={title}
      description="Pending decisions visible to you"
      actions={
        <Button variant="ghost" size="sm" asChild>
          <PermittedLink to="/approvals" hideWhenDenied>Review</PermittedLink>
        </Button>
      }
    >
      {rows.length === 0 ? (
        <EmptyState message="No pending approvals." to="/approvals" cta="Approval centre" />
      ) : (
        <ul className="space-y-3">
          {rows.map((a) => (
            <li key={a.id} className="rounded-xl border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{titleize(a.approval_type)}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {a.reference}
                    {a.amount ? ` · ${Number(a.amount).toLocaleString()}` : ""}
                    {a.reason ? ` · ${a.reason}` : ""}
                  </p>
                </div>
                <StatusPill tone="warning">
                  Level {a.level}/{a.max_level}
                </StatusPill>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function NotificationsPanel({ title, scope }: { title: string; scope: DashboardScope }) {
  const q = useDashboardNotifications(scope);
  const rows = q.data ?? [];
  if (q.error) return <PanelError title={title} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <PanelLoading title={title} />;
  return (
    <SectionCard
      title={title}
      description="Latest messages for you"
      actions={
        <Button variant="ghost" size="sm" asChild>
          <PermittedLink to="/notifications" hideWhenDenied>Open</PermittedLink>
        </Button>
      }
    >
      {rows.length === 0 ? (
        <EmptyState message="No notifications yet." />
      ) : (
        <ul className="space-y-3">
          {rows.map((n) => (
            <li key={n.id} className="flex gap-3">
              <span className="mt-0.5 rounded-lg bg-muted p-2 text-muted-foreground">
                <Bell className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{n.title}</p>
                <p className="truncate text-xs text-muted-foreground">{n.body}</p>
              </div>
              {!n.read_at ? <StatusPill tone="info">New</StatusPill> : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function AlertsPanel({ title, scope }: { title: string; scope: DashboardScope }) {
  const q = useDashboardAlerts(scope);
  const rows = q.data ?? [];
  if (q.error) return <PanelError title={title} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <PanelLoading title={title} />;
  return (
    <SectionCard
      className={rows.length ? "border-warning/40" : ""}
      title={title}
      description="Threshold rules evaluated against live data"
    >
      {rows.length === 0 ? (
        <EmptyState message="No open alerts — all monitored thresholds are within range." />
      ) : (
        <ul className="space-y-3">
          {rows.map((a) => (
            <li key={a.id} className="rounded-xl border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <AlertTriangle className="size-4 text-warning" />
                    {a.title}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{a.body}</p>
                </div>
                <StatusPill tone={a.severity === "critical" ? "destructive" : "warning"}>
                  {titleize(a.severity)}
                </StatusPill>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function ActivityPanel({ title, scope }: { title: string; scope: DashboardScope }) {
  const q = useRecentActivity(scope);
  const rows = q.data ?? [];
  if (q.error) return <PanelError title={title} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <PanelLoading title={title} />;
  return (
    <SectionCard tone="quiet" title={title} description="From the immutable audit trail">
      {rows.length === 0 ? (
        <EmptyState message="No recorded activity yet." to="/audit-logs" cta="Audit logs" />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="flex gap-3">
              <span className="mt-0.5 rounded-lg bg-muted p-2 text-muted-foreground">
                <ClipboardList className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {r.user_name} · {r.action}
                </p>
                <p className="text-xs text-muted-foreground">
                  {titleize(r.module)} · {new Date(r.created_at).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function TaskTrendPanel({ title, scope }: { title: string; scope: DashboardScope }) {
  const q = useTasksTrend(scope);
  const data = (q.data ?? []).map((d) => ({
    day: new Date(d.day).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    created: Number(d.created),
    completed: Number(d.completed),
  }));
  if (q.error) return <PanelError title={title} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <PanelLoading title={title} />;
  return (
    <ChartCard
      title={title}
      subtitle="Tasks per day · created vs completed"
      series={[
        { label: "Created", color: chartSeriesColor(0), kind: "area" },
        { label: "Completed", color: chartSeriesColor(1), kind: "area" },
      ]}
      source="tasks"
      empty={data.length === 0}
      emptyTitle="No task activity in this period"
      emptyDescription="No tasks were created or completed for the selected scope."
    >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ left: -18, right: 6, top: 6 }}>
            <ChartGradients idPrefix="dash" />
            <CartesianGrid {...GRID_PROPS} />
            <XAxis dataKey="day" {...AXIS_PROPS} />
            <YAxis {...AXIS_PROPS} allowDecimals={false} width={34} />
            <Tooltip {...TOOLTIP_PROPS} />
            <Area
              {...LINE_PROPS}
              dataKey="created"
              name="Created"
              stroke={chartSeriesColor(0)}
              fill={chartFill(0, "dash")}
            />
            <Area
              {...LINE_PROPS}
              dataKey="completed"
              name="Completed"
              stroke={chartSeriesColor(1)}
              fill={chartFill(1, "dash")}
            />
          </AreaChart>
        </ResponsiveContainer>
    </ChartCard>
  );
}

function WorkloadChart({
  title,
  subtitle,
  data,
}: {
  title: string;
  subtitle: string;
  data: { name: string; open: number; overdue: number }[];
}) {
  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      series={[
        { label: "Open", color: chartSeriesColor(0) },
        { label: "Overdue", color: chartSeriesColor(3) },
      ]}
      source="tasks"
      empty={data.length === 0}
      emptyTitle="Nothing to chart yet"
      emptyDescription="No active departments or stations are configured for this scope."
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: -22, right: 6 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="name" {...AXIS_PROPS} interval={0} angle={-18} textAnchor="end" height={54} />
          <YAxis {...AXIS_PROPS} allowDecimals={false} width={34} />
          <Tooltip
            {...TOOLTIP_PROPS}
            cursor={{ fill: "color-mix(in oklab, var(--color-primary) 8%, transparent)" }}
          />
          <Bar {...BAR_PROPS} dataKey="open" name="Open" fill={chartSeriesColor(0)} />
          <Bar {...BAR_PROPS} dataKey="overdue" name="Overdue" fill={chartSeriesColor(3)} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function DepartmentWorkloadPanel({ title }: { title: string }) {
  const q = useDepartmentWorkload();
  const data = (q.data ?? []).map((d) => ({
    name: d.department,
    open: Number(d.open_tasks),
    overdue: Number(d.overdue_tasks),
  }));
  if (q.error) return <PanelError title={title} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <PanelLoading title={title} />;
  return (
    <WorkloadChart title={title} subtitle="Open and overdue tasks by department" data={data} />
  );
}

function StationWorkloadPanel({ title }: { title: string }) {
  const q = useStationWorkload();
  const data = (q.data ?? []).map((d) => ({
    name: d.station,
    open: Number(d.open_tasks),
    overdue: Number(d.overdue_tasks),
  }));
  if (q.error) return <PanelError title={title} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <PanelLoading title={title} />;
  return (
    <WorkloadChart title={title} subtitle="Open and overdue tasks by station" data={data} />
  );
}

function KpiCataloguePanel({ title }: { title: string }) {
  const q = useKpiDefinitions();
  const rows = q.data ?? [];
  if (q.error) return <PanelError title={title} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <PanelLoading title={title} />;
  return (
    <SectionCard title={title} description="Metrics tracked for this organisation">
      {rows.length === 0 ? (
        <EmptyState message="No KPI definitions configured." />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {rows.map((k) => (
            <li key={k.key} className="rounded-xl border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{k.name}</p>
                <StatusPill tone={k.availability === "available" ? "success" : "default"}>
                  {k.availability === "available" ? "Tracked" : "Pending module"}
                </StatusPill>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{k.definition}</p>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function AiSummaryPanel({ title, scope }: { title: string; scope: DashboardScope }) {
  // Observations are counted by the scoped metrics service, not by the first
  // page of a truncated list — a summary must not under-report.
  const metrics = useDashboardMetrics(scope);
  const alerts = useDashboardAlerts(scope);

  const overdue = readMetric(metrics.data, "tasks.overdue") ?? 0;
  const unassigned = readMetric(metrics.data, "tasks.unassigned") ?? 0;
  const stale = readMetric(metrics.data, "approvals.delayed") ?? 0;
  const openAlerts = readMetric(metrics.data, "alerts.open") ?? (alerts.data ?? []).length;

  const observations: string[] = [];
  if (overdue) observations.push(`${overdue} task(s) in this scope are past their due date.`);
  if (unassigned) observations.push(`${unassigned} open task(s) have no assignee.`);
  if (stale) observations.push(`${stale} approval request(s) have waited more than 24 hours.`);
  if (openAlerts) observations.push(`${openAlerts} monitoring alert(s) are currently open.`);

  if (metrics.error) return <PanelError title={title} onRetry={() => void metrics.refetch()} />;
  if (metrics.isLoading) return <PanelLoading title={title} />;

  return (
    <SectionCard
      className="neo-accent-edge bg-primary-soft/25"
      title={title}
      description="Derived from live tasks, approvals and alerts in your authorised scope"
      actions={
        <Button variant="ghost" size="sm" asChild>
          <PermittedLink to="/ai-insights" hideWhenDenied>AI workspace</PermittedLink>
        </Button>
      }
    >
      {observations.length === 0 ? (
        <EmptyState message="Nothing needs attention in this scope right now." />
      ) : (
        <ul className="space-y-3">
          {observations.map((o) => (
            <li key={o} className="rounded-xl border border-border bg-primary-soft/50 p-3 text-sm">
              <Sparkles className="mb-2 size-4 text-primary" />
              {o}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
