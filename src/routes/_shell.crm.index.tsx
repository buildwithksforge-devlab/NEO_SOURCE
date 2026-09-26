import { LoadingState } from "@/components/common/StateSystem";
import { createFileRoute, Link } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import {
  Users,
  Crown,
  Building2,
  BadgePercent,
  MessageSquareWarning,
  Cake,
  Heart,
  MailWarning,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AXIS_PROPS,
  BAR_PROPS,
  GRID_PROPS,
  LINE_PROPS,
  TOOLTIP_PROPS,
  chartSeriesColor,
} from "@/components/charts/ChartKit";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { useCrmMetrics, titleCase } from "@/lib/crm";

export const Route = createFileRoute("/_shell/crm/")({
  head: () => ({
    meta: [
      { title: "CRM Dashboard — Guest Relationship Management" },
      {
        name: "description",
        content:
          "Live guest relationship metrics: customers, VIPs, loyalty members, complaints and consent coverage.",
      },
      { property: "og:title", content: "CRM Dashboard — Guest Relationship Management" },
      {
        property: "og:description",
        content: "Live guest relationship metrics across every hospitality outlet.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

function Page() {
  const { data, isLoading } = useCrmMetrics();

  return (
    <div>
      <PageHeader
        eyebrow="Guest CRM"
        title="CRM Dashboard"
        description="Every figure below is calculated from recorded CRM data only. Categories fed by modules that are not yet operational stay empty rather than showing sample numbers."
        actions={
          <>
            <Button asChild size="sm">
              <Link to="/crm/customers">Customer directory</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/crm/feedback">Open complaints</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/crm/duplicates">Review duplicates</Link>
            </Button>
          </>
        }
      />

      {isLoading || !data ? (
        <LoadingState variant="cards" rows={8} />
      ) : (
        <>
          <div className="neo-kpi-grid">
            <StatCard
              lead
              label="Total customers"
              value={String(data.totalCustomers)}
              icon={Users}
            />
            <StatCard
              label="New (30 days)"
              value={String(data.newCustomers)}
              icon={Heart}
              tone="accent"
            />
            <StatCard label="VIP guests" value={String(data.vip)} icon={Crown} tone="warning" />
            <StatCard
              label="Corporate accounts"
              value={String(data.corporateAccounts)}
              icon={Building2}
            />
            <StatCard
              label="Loyalty members"
              value={String(data.loyaltyMembers)}
              icon={BadgePercent}
              tone="success"
            />
            <StatCard
              label="Open complaints"
              value={String(data.openComplaints)}
              hint={`${data.overdueComplaints} overdue`}
              icon={MessageSquareWarning}
              tone="warning"
            />
            <StatCard
              label="Satisfaction score"
              value={data.satisfaction === null ? "No ratings yet" : `${data.satisfaction} / 5`}
              icon={Heart}
            />
            <StatCard
              label="Marketing opt-in"
              value={`${data.optIn}%`}
              hint={`${data.inactive} inactive guests`}
              icon={MailWarning}
            />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <SectionCard title="Customer growth" description="New CRM profiles created per month.">
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.growth}>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis dataKey="month" {...AXIS_PROPS} />
                    <YAxis allowDecimals={false} {...AXIS_PROPS} />
                    <Tooltip {...TOOLTIP_PROPS} />
                    <Line {...LINE_PROPS} dataKey="customers" stroke={chartSeriesColor(0)} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </SectionCard>

            <SectionCard
              title="Customer type distribution"
              description="Recorded customer types across the organisation."
            >
              {data.typeBreakdown.length === 0 ? (
                <EmptyNote>No customers recorded yet.</EmptyNote>
              ) : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.typeBreakdown}>
                      <CartesianGrid {...GRID_PROPS} />
                      <XAxis dataKey="type" {...AXIS_PROPS} />
                      <YAxis allowDecimals={false} {...AXIS_PROPS} />
                      <Tooltip {...TOOLTIP_PROPS} />
                      <Bar {...BAR_PROPS} dataKey="count" fill={chartSeriesColor(0)} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </SectionCard>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <SectionCard title="Recent customers">
              {data.recentCustomers.length === 0 ? (
                <EmptyNote>No customer profiles yet.</EmptyNote>
              ) : (
                <ul className="space-y-2 text-sm">
                  {data.recentCustomers.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2">
                      <Link
                        to="/crm/customers/$id"
                        params={{ id: c.id }}
                        className="truncate hover:underline"
                      >
                        {c.full_name}
                      </Link>
                      <StatusPill tone={c.is_vip ? "accent" : "default"}>
                        {titleCase(c.customer_type)}
                      </StatusPill>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="Upcoming birthdays" description="Next 30 days, where recorded.">
              {data.birthdays.length === 0 ? (
                <EmptyNote>No birthdays recorded in the next 30 days.</EmptyNote>
              ) : (
                <ul className="space-y-2 text-sm">
                  {data.birthdays.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{c.full_name}</span>
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <Cake className="size-3.5" />
                        {c.date_of_birth}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="Upcoming anniversaries" description="Voluntarily recorded only.">
              {data.anniversaries.length === 0 ? (
                <EmptyNote>No anniversaries recorded in the next 30 days.</EmptyNote>
              ) : (
                <ul className="space-y-2 text-sm">
                  {data.anniversaries.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{c.full_name}</span>
                      <span className="text-muted-foreground">{c.anniversary_date}</span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>

          <SectionCard
            className="mt-6"
            title="Awaiting operational modules"
            description="These CRM measures activate automatically once the source modules begin recording data."
          >
            <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2 lg:grid-cols-3">
              {[
                "Booking source performance — Reservations",
                "Spend by service — Finance & POS",
                "VIP arrivals — Front Office",
                "Corporate outstanding balance — Finance",
                "Repeat-guest rate — Reservations",
                "Communication channel performance — messaging providers",
              ].map((item) => (
                <li key={item} className="rounded-lg border border-dashed border-border px-3 py-2">
                  {item}
                </li>
              ))}
            </ul>
          </SectionCard>
        </>
      )}
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

// Money and customer records: the screen asks for the capability its route
// declares, so the menu and the page can never disagree.
function GuardedPage() {
  return (
    <OpsGuard path="/crm">
      <Page />
    </OpsGuard>
  );
}
