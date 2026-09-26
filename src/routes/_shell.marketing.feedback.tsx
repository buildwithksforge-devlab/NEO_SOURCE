import { LoadingState } from "@/components/common/StateSystem";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { EmptyState, MetricTile } from "@/components/marketing/MarketingShared";
import { useFeedbackAnalytics } from "@/lib/marketing-data";
import { titleCase } from "@/lib/marketing";

export const Route = createFileRoute("/_shell/marketing/feedback")({
  head: () => ({
    meta: [
      { title: "Feedback Analytics — Marketing & CRM" },
      {
        name: "description",
        content:
          "Ratings, themes and response times calculated directly from recorded guest feedback.",
      },
      { property: "og:title", content: "Feedback Analytics — Marketing & CRM" },
      {
        property: "og:description",
        content: "Guest feedback ratings, categories and response times.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;

function Page() {
  const { data, isLoading } = useFeedbackAnalytics();
  const rows = (data ?? []) as Row[];

  if (isLoading) {
    return <LoadingState variant="cards" rows={3} />;
  }

  const rated = rows.filter((r) => r["rating"] != null);
  const avg = rated.length
    ? rated.reduce((s, r) => s + Number(r["rating"]), 0) / rated.length
    : null;
  const promoters = rated.filter((r) => Number(r["rating"]) >= 4).length;
  const detractors = rated.filter((r) => Number(r["rating"]) <= 2).length;
  const nps = rated.length ? Math.round(((promoters - detractors) / rated.length) * 100) : null;

  const responded = rows.filter((r) => r["first_response_at"] && r["received_at"]);
  const avgResponseHours = responded.length
    ? responded.reduce(
        (s, r) =>
          s +
          (new Date(String(r["first_response_at"])).getTime() -
            new Date(String(r["received_at"])).getTime()) /
            3_600_000,
        0,
      ) / responded.length
    : null;

  const byCategory = new Map<string, { count: number; total: number; rated: number }>();
  for (const r of rows) {
    const key = String(r["category"] ?? "uncategorised");
    const entry = byCategory.get(key) ?? { count: 0, total: 0, rated: 0 };
    entry.count += 1;
    if (r["rating"] != null) {
      entry.total += Number(r["rating"]);
      entry.rated += 1;
    }
    byCategory.set(key, entry);
  }
  const categories = [...byCategory.entries()].sort((a, b) => b[1].count - a[1].count);

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Feedback Analytics"
        description="Calculated from the Phase 4 feedback records. Sentiment is derived from the recorded rating only — no free-text guessing."
      />

      {!rows.length ? (
        <SectionCard title="Feedback">
          <EmptyState
            icon={Activity}
            title="No feedback recorded"
            description="Feedback collected after stays, meals and events will be analysed here."
          />
        </SectionCard>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <MetricTile label="Responses" value={String(rows.length)} />
            <MetricTile
              label="Average rating"
              value={avg == null ? "—" : `${avg.toFixed(2)} / 5`}
            />
            <MetricTile
              label="Net promoter (rating-based)"
              value={nps == null ? "—" : String(nps)}
              hint="Promoters 4–5 minus detractors 1–2"
              tone={nps != null && nps > 0 ? "success" : "default"}
            />
            <MetricTile
              label="Avg. first response"
              value={avgResponseHours == null ? "—" : `${avgResponseHours.toFixed(1)}h`}
              hint={avgResponseHours == null ? "No responses recorded" : (undefined as never)}
            />
          </div>

          <SectionCard
            className="mt-6"
            title="By category"
            description="Volume and average rating per recorded category."
          >
            <ul className="space-y-2">
              {categories.map(([category, stat]) => (
                <li
                  key={category}
                  className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <span className="font-medium text-foreground">{titleCase(category)}</span>
                  <span className="text-muted-foreground">
                    {stat.count} response(s)
                    {stat.rated ? ` · avg ${(stat.total / stat.rated).toFixed(2)}` : " · unrated"}
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard
            className="mt-6"
            title="Resolution"
            description="Open versus resolved feedback."
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <MetricTile
                label="Resolved"
                value={String(rows.filter((r) => r["resolved_at"]).length)}
                tone="success"
              />
              <MetricTile
                label="Unresolved"
                value={String(rows.filter((r) => !r["resolved_at"]).length)}
                tone="warning"
              />
              <MetricTile
                label="Awaiting first response"
                value={String(rows.filter((r) => !r["first_response_at"]).length)}
              />
            </div>
          </SectionCard>
        </>
      )}
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/feedback">
      <Page />
    </OpsGuard>
  );
}
