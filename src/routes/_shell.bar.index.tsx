import type { ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { TONE_BORDER, TONE_TINT, type Tone } from "@/lib/tone";
import {
  PageHeader,
  SectionCard,
  SectionHeading,
  StatCard,
  StatusPill,
} from "@/components/common/DataDisplay";
import {
  Bell,
  CheckCircle2,
  Martini,
  ShieldCheck,
  Timer,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { BarGuard, EmptyState, QueryState } from "@/components/bar/BarShared";
import { Button } from "@/components/ui/button";
import { money, titleCase } from "@/lib/pos";
import { barNum, barStr, useBarMetrics, useBarOverview, useBarQueue, type BarRow } from "@/lib/bar";


export const Route = createFileRoute("/_shell/bar/")({
  head: () => ({
    meta: [
      { title: "Bar Dashboard — NEØ" },
      {
        name: "description",
        content:
          "Live bar queue, today's bar sales, approvals awaiting the Bar Manager, wastage value and attendant workload for the Bar department.",
      },
      { property: "og:title", content: "Bar Dashboard — NEØ" },
      {
        property: "og:description",
        content: "Department-level view of bar service, sales, approvals and wastage.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <BarGuard action="overview.view">
      <BarDashboard />
    </BarGuard>
  ),
});

function BarDashboard() {
  const metrics = useBarMetrics();
  const live = useBarQueue("live", "all");
  const overview = useBarOverview();

  const m = (metrics.data ?? {}) as BarRow;
  const queue = (m["queue"] ?? {}) as Record<string, unknown>;
  const sales = (m["sales"] ?? {}) as Record<string, unknown>;
  const wastage = (m["wastage"] ?? {}) as Record<string, unknown>;
  const approvals = (m["approvals"] ?? {}) as Record<string, unknown>;
  const attendants = (m["attendants"] ?? []) as Record<string, unknown>[];
  const rows = (live.data ?? []) as BarRow[];

  const ov = overview.data;
  const openTabs = ov?.open_tabs;
  const lowStock = ov?.low_stock;
  const barApprovals = ov?.approvals;
  const barWaste = ov?.wastage;

  const liveTotal =
    barNum(queue["new"]) + barNum(queue["preparing"]) + barNum(queue["ready"]);
  const delayed = barNum(queue["delayed"]);

  return (
    <div>
      <PageHeader
        eyebrow="Bar Department"
        title="Bar Dashboard"
        icon={Martini}
        description="The whole bar in one view: live service, today's performance, approvals awaiting you, stock and wastage control, and who is carrying the workload."
        meta={
          <>
            <StatusPill tone={liveTotal > 0 ? "info" : "default"}>
              {`${liveTotal} in service`}
            </StatusPill>
            <StatusPill tone={delayed > 0 ? "warning" : "success"}>
              {delayed > 0 ? `${delayed} past target` : "On target"}
            </StatusPill>
            <StatusPill tone="default">{`${money(barNum(sales["revenue_today"]))} today`}</StatusPill>
          </>
        }
        actions={
          <Button asChild>
            <Link to="/bar/queue">Open bar queue</Link>
          </Button>
        }
      />

      <QueryState isLoading={metrics.isLoading} error={metrics.error} isEmpty={false} empty={null}>
        {/* 1 — service right now: four weighted metrics, not twelve equals. */}
        <SectionHeading
          title="Service right now"
          description="Live bar tickets by stage, refreshed straight from the station queue."
        />
        <div className="neo-kpi-grid mb-4">
          <StatCard
            lead
            label="New orders"
            value={String(barNum(queue["new"]))}
            hint="Not yet accepted"
            icon={Bell}
            to="/bar/queue"
            actionLabel="Accept orders"
          />
          <StatCard
            label="Preparing"
            value={String(barNum(queue["preparing"]))}
            hint="In production"
            icon={Martini}
            tone="info"
            to="/bar/queue"
            actionLabel="Open queue"
          />
          <StatCard
            label="Ready"
            value={String(barNum(queue["ready"]))}
            hint="Awaiting collection"
            icon={CheckCircle2}
            tone="success"
            to="/bar/queue"
            actionLabel="Serve now"
          />
          <StatCard
            label="Delayed"
            value={String(delayed)}
            hint="Past preparation target"
            icon={Timer}
            tone={delayed > 0 ? "warning" : "default"}
            to="/bar/queue"
            actionLabel="Clear delays"
          />
        </div>

        {/* Secondary counts are a grouped cluster, not four more floating tiles. */}
        <div className="neo-stat-cluster mb-6">
          <ClusterStat
            label="Unassigned"
            value={String(barNum(queue["unassigned"]))}
            to="/bar/queue"
          />
          <ClusterStat
            label="Completed today"
            value={String(barNum(queue["completed_today"]))}
            to="/bar/queue"
          />
          <ClusterStat
            label="Cancelled today"
            value={String(barNum(queue["cancelled_today"]))}
            to="/bar/queue"
          />
          <ClusterStat
            label="Orders today"
            value={String(barNum(sales["orders_today"]))}
            to="/bar/sell"
          />
        </div>

        {/* 2 — performance story. */}
        <div className="mb-6 grid gap-4 lg:grid-cols-3">
          <SectionCard accent title="Today's bar performance" icon={TrendingUp}>
            <dl className="space-y-2 text-sm">
              <Row label="Bar sales" value={money(barNum(sales["revenue_today"]))} />
              <Row label="Orders" value={String(barNum(sales["orders_today"]))} />
              <Row label="Average order value" value={money(barNum(sales["average_order"]))} />
            </dl>
            <div className="mt-4">
              <QueueMix
                stages={[
                  { label: "New", value: barNum(queue["new"]), tone: "bg-primary" },
                  { label: "Preparing", value: barNum(queue["preparing"]), tone: "bg-info" },
                  { label: "Ready", value: barNum(queue["ready"]), tone: "bg-success" },
                ]}
              />
            </div>
          </SectionCard>

          <SectionCard
            title="Approvals"
            icon={ShieldCheck}
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link to="/approvals">Review</Link>
              </Button>
            }
          >
            <dl className="space-y-2 text-sm">
              <Row label="Awaiting my approval" value={String(barNum(approvals["pending"]))} />
              <Row label="Approved today" value={String(barNum(approvals["approved_today"]))} />
              <Row label="Rejected today" value={String(barNum(approvals["rejected_today"]))} />
            </dl>
            <p className="neo-callout mt-3 text-xs text-muted-foreground">
              Discounts, voids, complimentaries and wastage above your configured limit escalate
              automatically to the next authorised approver.
            </p>
          </SectionCard>

          <SectionCard
            title="Wastage & spillage"
            icon={Trash2}
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link to="/bar/wastage">Open log</Link>
              </Button>
            }
          >
            <dl className="space-y-2 text-sm">
              <Row label="Records today" value={String(barNum(wastage["records_today"]))} />
              <Row label="Value today" value={money(barNum(wastage["value_today"]))} />
              <Row label="Awaiting approval" value={String(barNum(wastage["awaiting_approval"]))} />
            </dl>
          </SectionCard>
        </div>

        <SectionHeading
          title="Needs attention"
          description="Unsettled money, stock at risk, decisions waiting on a manager and losses logged today."
        />
        <div className="mb-6 grid gap-4 lg:grid-cols-2">

          <SectionCard
            title="Open bar tabs"
            description="Unsettled bar tabs, including restaurant orders routed to a bar station."
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link to="/bar/sell">Open selling</Link>
              </Button>
            }
          >
            <QueryState
              isLoading={overview.isLoading}
              error={overview.error}
              isEmpty={(openTabs?.rows.length ?? 0) === 0}
              empty={
                <EmptyState
                  title="No open bar tabs"
                  description="Tabs appear here from the moment they are opened until they are settled or charged to a room."
                />
              }
            >
              <ul className="space-y-1.5">
                {(openTabs?.rows ?? []).map((t) => (
                  <BarListRow
                    key={barStr(t["id"])}
                    accent="info"
                    monogram={barStr(t["table_code"], "TAB")}
                    title={`${barStr(t["order_number"])} · ${barStr(
                      t["guest_name"],
                      barStr(t["table_code"], "Walk-in"),
                    )}`}
                    meta={`${barNum(t["item_count"])} items · ${titleCase(
                      barStr(t["status"], "open"),
                    )}`}
                    trailing={money(barNum(t["grand_total"]))}
                    trailingLabel="Unsettled"
                  />
                ))}
              </ul>
            </QueryState>
          </SectionCard>

          <SectionCard
            title="Low beverage stock"
            description="Bar storage locations at or below their reorder level."
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link to="/bar/requisitions">Raise requisition</Link>
              </Button>
            }
          >
            <QueryState
              isLoading={overview.isLoading}
              error={overview.error}
              isEmpty={(lowStock?.rows.length ?? 0) === 0}
              empty={
                <EmptyState
                  title="No low-stock alerts"
                  description="Beverage items fall onto this list once their bar holding drops to the reorder level set in Stores."
                />
              }
            >
              <ul className="space-y-1.5">
                {(lowStock?.rows ?? []).map((r) => (
                  <BarListRow
                    key={barStr(r["id"])}
                    accent="warning"
                    monogram={barStr(r["name"], "ITM")}
                    title={barStr(r["name"])}
                    meta={`${barStr(r["location_name"], "Bar store")} · reorder ${barNum(
                      r["reorder_quantity"],
                    )} ${barStr(r["base_unit"], "")}`}
                    trailing={`${barNum(r["on_hand"])} / ${barNum(r["min_level"])}`}
                    trailingLabel="On hand / min"
                  />
                ))}
              </ul>
            </QueryState>
          </SectionCard>

          <SectionCard
            title="Bar approvals awaiting a decision"
            description="Discounts, voids, complimentaries and wastage raised by the Bar."
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link to="/approvals">Review</Link>
              </Button>
            }
          >
            <QueryState
              isLoading={overview.isLoading}
              error={overview.error}
              isEmpty={(barApprovals?.rows.length ?? 0) === 0}
              empty={
                <EmptyState
                  title="Nothing awaiting approval"
                  description="Requests raised by the Bar appear here until an authorised approver decides them."
                />
              }
            >
              <ul className="space-y-1.5">
                {(barApprovals?.rows ?? []).map((a) => (
                  <BarListRow
                    key={barStr(a["id"])}
                    accent="accent"
                    monogram={titleCase(barStr(a["approval_type"], "Req"))}
                    title={`${titleCase(barStr(a["approval_type"], "Request"))} · ${barStr(
                      a["reference"],
                    )}`}
                    meta={`${barStr(a["requester"], "Unknown requester")} · ${barStr(
                      a["reason"],
                      "No reason given",
                    )}`}
                    trailing={money(barNum(a["amount"]))}
                    trailingLabel="Value"
                  />
                ))}
              </ul>
            </QueryState>
          </SectionCard>

          <SectionCard
            title="Recent bar wastage"
            description="Spillage, breakage and over-pour logged at bar stations."
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link to="/bar/wastage">Open log</Link>
              </Button>
            }
          >
            <QueryState
              isLoading={overview.isLoading}
              error={overview.error}
              isEmpty={(barWaste?.rows.length ?? 0) === 0}
              empty={
                <EmptyState
                  title="No wastage logged"
                  description="Every spill, breakage and over-pour recorded at the bar appears here for review."
                />
              }
            >
              <ul className="space-y-1.5">
                {(barWaste?.rows ?? []).map((w) => (
                  <BarListRow
                    key={barStr(w["id"])}
                    accent={barStr(w["status"]) === "approved" ? "success" : "warning"}
                    monogram={barStr(w["ingredient_name"], "WST")}
                    title={`${barStr(w["ingredient_name"])} · ${barNum(w["quantity"])} ${barStr(
                      w["unit"],
                      "",
                    )}`}
                    meta={`${titleCase(barStr(w["category"], "Wastage"))} · ${barStr(
                      w["reason"],
                      "No reason given",
                    )}`}
                    trailing={
                      <StatusPill
                        tone={barStr(w["status"]) === "approved" ? "success" : "warning"}
                      >
                        {titleCase(barStr(w["status"], "pending"))}
                      </StatusPill>
                    }
                  />
                ))}
              </ul>
            </QueryState>
          </SectionCard>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Live bar queue">
            <QueryState
              isLoading={live.isLoading}
              error={live.error}
              isEmpty={rows.length === 0}
              empty={
                <EmptyState
                  title="Nothing in the bar queue"
                  description="New drink orders appear here the moment they are sent to the bar."
                />
              }
            >
              <ul className="space-y-1.5">
                {rows.slice(0, 8).map((r) => (
                  <BarListRow
                    key={String(r["ticket_id"])}
                    accent={r["is_delayed"] ? "warning" : "info"}
                    monogram={barStr(r["table_code"], "BAR")}
                    title={`${barStr(r["ticket_number"])} · ${barStr(r["source"], "Bar")}`}
                    meta={`${barStr(r["table_code"], "No table")} · ${barStr(
                      r["assigned_name"],
                      "Unassigned",
                    )} · ${barNum(r["age_minutes"])} min`}
                    trailing={
                      <StatusPill tone={r["is_delayed"] ? "warning" : "default"}>
                        {titleCase(barStr(r["status"], "new"))}
                      </StatusPill>
                    }
                  />
                ))}
              </ul>
            </QueryState>
          </SectionCard>

          <SectionCard title="Attendant workload">
            {attendants.length === 0 ? (
              <EmptyState
                title="No attendant activity yet"
                description="Workload appears once bar attendants accept orders from the queue."
              />
            ) : (
              <ul className="space-y-1.5">
                {attendants.map((a) => (
                  <BarListRow
                    key={barStr(a["attendant"])}
                    accent={barNum(a["open_tickets"]) > 0 ? "info" : "default"}
                    monogram={barStr(a["attendant"], "ATT")}
                    title={barStr(a["attendant"])}
                    meta={`${barNum(a["completed_tickets"])} completed today`}
                    trailing={String(barNum(a["open_tickets"]))}
                    trailingLabel="Open"
                  />
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </QueryState>
    </div>
  );
}

/**
 * The one row shape the bar department uses everywhere: an identity mark, the
 * subject, its context and a single trailing fact. Repeating one row makes the
 * lower half of the dashboard scannable instead of six different lists.
 */
function BarListRow({
  monogram,
  title,
  meta,
  trailing,
  trailingLabel,
  accent = "default",
}: {
  monogram: string;
  title: string;
  meta?: string;
  trailing?: ReactNode;
  trailingLabel?: string;
  accent?: Tone;
}) {
  return (
    <li
      className={cn(
        "relative grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 overflow-hidden rounded-xl border bg-card/60 p-2.5 pl-4 transition-shadow hover:shadow-sm",
        TONE_BORDER[accent],
      )}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", BAR_ACCENT[accent])} />
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg text-[0.65rem] font-semibold uppercase",
            TONE_TINT[accent],
          )}
        >
          {monogram.slice(0, 3)}
        </span>
        <div className="min-w-0">
          <p className="neo-line-1 text-sm font-semibold">{title}</p>
          {meta ? <p className="neo-line-1 text-xs text-muted-foreground">{meta}</p> : null}
        </div>
      </div>
      {trailing ? (
        <div className="shrink-0 text-right">
          <div className="neo-atomic text-sm font-semibold tabular-nums">{trailing}</div>
          {trailingLabel ? (
            <p className="text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground">
              {trailingLabel}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

const BAR_ACCENT: Record<Tone, string> = {
  default: "bg-border",
  accent: "bg-accent/70",
  success: "bg-success/70",
  warning: "bg-warning/80",
  info: "bg-info/70",
  destructive: "bg-destructive/70",
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

function ClusterStat({ label, value, to }: { label: string; value: string; to?: string }) {
  const body = (
    <>
      <p className="neo-line-1 text-xs text-muted-foreground">{label}</p>
      <p className="neo-atomic text-lg font-semibold tabular-nums">{value}</p>
    </>
  );
  if (!to) return <div className="min-w-0">{body}</div>;
  return (
    <Link
      to={to}
      className="min-w-0 rounded-lg px-1 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {body}
    </Link>
  );
}

function QueueMix({
  stages,
}: {
  stages: { label: string; value: number; tone: string }[];
}) {
  const total = stages.reduce((sum, s) => sum + s.value, 0);
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {total > 0
          ? stages.map((s) => (
              <span
                key={s.label}
                className={s.tone}
                style={{ width: `${(s.value / total) * 100}%` }}
              />
            ))
          : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {stages.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${s.tone}`} />
            {s.label} · {s.value}
          </span>
        ))}
      </div>
    </div>
  );
}
