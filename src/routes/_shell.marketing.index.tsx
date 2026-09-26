import { LoadingState } from "@/components/common/StateSystem";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  BadgePercent,
  Megaphone,
  Send,
  Sparkles,
  Star,
  TrendingUp,
  Users,
} from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { AdvisoryPanel, MetricTile } from "@/components/marketing/MarketingShared";
import { useMarketingMetrics, useMarketingSettings } from "@/lib/marketing-data";
import { calculateRomi, percent } from "@/lib/marketing";

export const Route = createFileRoute("/_shell/marketing/")({
  head: () => ({
    meta: [
      { title: "Marketing Dashboard — Guest Engagement & Campaign Performance" },
      {
        name: "description",
        content:
          "Leads, campaigns, loyalty, reputation and attributed revenue calculated from recorded operational data only.",
      },
      {
        property: "og:title",
        content: "Marketing Dashboard — Guest Engagement & Campaign Performance",
      },
      {
        property: "og:description",
        content: "Live marketing performance across leads, campaigns, loyalty and reputation.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

function Page() {
  const { data, isLoading } = useMarketingMetrics();
  const { data: settings } = useMarketingSettings();

  if (isLoading || !data) {
    return <LoadingState variant="cards" rows={8} />;
  }

  if (data.error) {
    return (
      <SectionCard
        title="Marketing data is restricted"
        description="Your account does not hold the marketing view permission for this organization."
      >
        <p className="text-sm text-muted-foreground">
          Ask an administrator to grant the marketing module view permission.
        </p>
      </SectionCard>
    );
  }

  const romi = calculateRomi({
    cost: Number(data.marketing_cost ?? 0),
    revenue: Number(data.attributed_revenue ?? 0),
  });
  const aiConfigured = String(settings?.["ai_status"] ?? "not_configured") === "configured";

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Marketing Dashboard"
        description="Every number here is derived from recorded leads, campaigns, loyalty, reviews and finance data. Channels without a configured provider report nothing rather than estimated results."
        actions={
          <>
            <Button asChild size="sm">
              <Link to="/marketing/campaigns">New campaign</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/marketing/leads">Capture lead</Link>
            </Button>
          </>
        }
      />

      <div className="neo-kpi-grid">
        <StatCard lead label="Leads (period)" value={String(data.leads_total ?? 0)} icon={Users} />
        <StatCard
          label="Awaiting follow-up"
          value={String(data.leads_overdue ?? 0)}
          icon={AlertTriangle}
          tone="warning"
          hint="Overdue follow-ups on open leads"
        />
        <StatCard
          label="Campaigns running"
          value={String(data.campaigns_running ?? 0)}
          icon={Megaphone}
          tone="accent"
        />
        <StatCard
          label="Loyalty members"
          value={String(data.loyalty_members ?? 0)}
          icon={BadgePercent}
          tone="success"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <SectionCard
          title="Lead pipeline"
          description="Open opportunities and their recorded estimated value."
          className="lg:col-span-2"
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <MetricTile label="New" value={String(data.leads_new ?? 0)} />
            <MetricTile label="Won (period)" value={String(data.leads_won ?? 0)} tone="success" />
            <MetricTile label="Overdue" value={String(data.leads_overdue ?? 0)} tone="warning" />
            <MetricTile
              label="Pipeline value"
              value={Number(data.pipeline_value ?? 0).toLocaleString()}
              hint="Estimated value of open leads"
            />
          </div>
        </SectionCard>

        <SectionCard title="Reputation" description="Recorded reviews and open recovery work.">
          <div className="space-y-3">
            <MetricTile label="Reviews (period)" value={String(data.reviews_total ?? 0)} />
            <MetricTile
              label="Average rating"
              value={data.average_rating != null ? `${data.average_rating} / 5` : "—"}
              {...(data.average_rating == null ? { hint: "No rated reviews in this period" } : {})}
            />

            <MetricTile
              label="Open recovery cases"
              value={String(data.open_recovery_cases ?? 0)}
              tone={Number(data.open_recovery_cases ?? 0) > 0 ? "warning" : "default"}
            />
          </div>
        </SectionCard>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Campaign delivery"
          description="Only statuses genuinely reported by a configured provider are counted. Opens and clicks are never inferred."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <MetricTile label="Messages queued or sent" value={String(data.messages_sent ?? 0)} />
            <MetricTile
              label="Provider-confirmed delivery"
              value={String(data.messages_delivered ?? 0)}
              hint={percent(Number(data.messages_delivered ?? 0), Number(data.messages_sent ?? 0))}
            />
            <MetricTile
              label="Excluded by consent or suppression"
              value={String(data.messages_excluded ?? 0)}
              tone="warning"
            />
            <MetricTile label="Suppressed contacts" value={String(data.suppressed_contacts ?? 0)} />
          </div>
        </SectionCard>

        <SectionCard
          title="Spend and return"
          description="Gross profit is not recorded per campaign, so the figure below is a revenue-based return and not true ROMI."
          actions={
            <Button asChild size="sm" variant="outline">
              <Link to="/marketing/reports">Full report</Link>
            </Button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricTile
              label="Marketing cost"
              value={Number(data.marketing_cost ?? 0).toLocaleString()}
            />
            <MetricTile
              label="Attributed revenue"
              value={Number(data.attributed_revenue ?? 0).toLocaleString()}
            />
            <MetricTile
              label={romi.ratio == null ? "Return" : "Revenue-based return"}
              value={romi.ratio == null ? "—" : `${(romi.ratio * 100).toFixed(1)}%`}
              hint={romi.label}
              tone={romi.ratio != null && romi.ratio > 0 ? "success" : "default"}
            />
          </div>
        </SectionCard>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Loyalty & offers"
          description="Live figures from the single loyalty ledger."
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricTile label="Members" value={String(data.loyalty_members ?? 0)} />
            <MetricTile
              label="Points outstanding"
              value={Number(data.points_outstanding ?? 0).toLocaleString()}
            />
            <MetricTile label="Active vouchers" value={String(data.active_vouchers ?? 0)} />
          </div>
        </SectionCard>

        <SectionCard
          title="AI Marketing Assistant"
          description="Advisory suggestions only — nothing is sent, activated or awarded automatically."
        >
          <AdvisoryPanel
            configured={aiConfigured}
            insights={[
              {
                title: "Follow-up backlog",
                body: `${data.leads_overdue ?? 0} open leads have passed their follow-up date. Prioritise the highest recorded estimated value first.`,
              },
              {
                title: "Reachability",
                body: `${data.messages_excluded ?? 0} audience members were excluded on consent or suppression grounds. Consider a consent refresh campaign on a permitted channel.`,
              },
            ]}
          />
        </SectionCard>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/marketing/reviews">
            <Star className="mr-1.5 size-4" /> Reputation inbox
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/marketing/automations">
            <Sparkles className="mr-1.5 size-4" /> Customer journeys
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/marketing/consent">
            <Send className="mr-1.5 size-4" /> Consent register
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/marketing/reports">
            <TrendingUp className="mr-1.5 size-4" /> Attribution
          </Link>
        </Button>
      </div>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing">
      <Page />
    </OpsGuard>
  );
}
