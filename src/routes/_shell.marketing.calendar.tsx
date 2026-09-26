import { useMemo, useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarRange } from "lucide-react";
import {
  CalendarDayLegend,
  CalendarMonthGrid,
  CalendarToolbar,
} from "@/components/common/CalendarSurface";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState } from "@/components/marketing/MarketingShared";
import { useCampaigns, useJourneys } from "@/lib/marketing-data";
import { campaignStatusLabels, campaignTone, formatDateTime, titleCase } from "@/lib/marketing";

export const Route = createFileRoute("/_shell/marketing/calendar")({
  head: () => ({
    meta: [
      { title: "Marketing Calendar — Marketing & CRM" },
      {
        name: "description",
        content:
          "Month view of scheduled campaigns and active guest journeys so sends never collide.",
      },
      { property: "og:title", content: "Marketing Calendar — Marketing & CRM" },
      { property: "og:description", content: "Scheduled campaign and journey calendar." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;

function Page() {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const { data: campaigns } = useCampaigns();
  const { data: journeys } = useJourneys();

  const days = useMemo(() => {
    const first = new Date(cursor);
    const start = new Date(first);
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [cursor]);

  const scheduled = (campaigns ?? []).filter((c: Row) => c["scheduled_at"]) as Row[];
  const byDay = new Map<string, Row[]>();
  for (const c of scheduled) {
    const key = new Date(String(c["scheduled_at"])).toDateString();
    byDay.set(key, [...(byDay.get(key) ?? []), c]);
  }

  const monthLabel = cursor.toLocaleString(undefined, { month: "long", year: "numeric" });

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Marketing Calendar"
        description="Scheduled campaigns and running journeys in one view. Use it to avoid overlapping sends to the same audience."
        actions={
          <CalendarToolbar
            label={monthLabel}
            prevLabel="Previous month"
            nextLabel="Next month"
            onPrev={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            onNext={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            onToday={() => {
              const now = new Date();
              setCursor(new Date(now.getFullYear(), now.getMonth(), 1));
            }}
          />
        }
      />

      {!scheduled.length ? (
        <SectionCard title="Schedule" description="Nothing scheduled.">
          <EmptyState
            icon={CalendarRange}
            title="No scheduled campaigns"
            description="Campaigns with a scheduled send date appear on this calendar."
          />
        </SectionCard>
      ) : (
        <div className="rounded-xl border border-border bg-card p-3">
          <CalendarDayLegend className="mb-3" states={["today", "available", "limited"]} />
          <CalendarMonthGrid
            ariaLabel={monthLabel}
            weekdays={["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]}
            cells={days.map((d) => {
              const items = byDay.get(d.toDateString()) ?? [];
              return {
                key: d.toISOString(),
                day: d.getDate(),
                outside: d.getMonth() !== cursor.getMonth(),
                today: d.toDateString() === new Date().toDateString(),
                count: items.length,
                content: items.map((c) => (
                  <div
                    key={String(c["id"])}
                    className="min-w-0 rounded bg-primary/10 px-1.5 py-1 text-[0.65rem] leading-tight text-foreground"
                  >
                    <p className="truncate font-medium">{String(c["name"])}</p>
                    <p className="truncate text-muted-foreground">
                      {titleCase(String(c["channel"]))}
                    </p>
                  </div>
                )),
              };
            })}
          />
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Upcoming sends"
          description="Next scheduled campaigns across every channel."
        >
          {!scheduled.length ? (
            <p className="text-sm text-muted-foreground">No upcoming sends.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {scheduled
                .slice()
                .sort((a, b) => String(a["scheduled_at"]).localeCompare(String(b["scheduled_at"])))
                .slice(0, 8)
                .map((c) => (
                  <li
                    key={String(c["id"])}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                  >
                    <div>
                      <p className="font-medium text-foreground">{String(c["name"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(c["scheduled_at"])}
                      </p>
                    </div>
                    <StatusPill tone={campaignTone(String(c["status"]))}>
                      {campaignStatusLabels[
                        String(c["status"]) as keyof typeof campaignStatusLabels
                      ] ?? titleCase(String(c["status"]))}
                    </StatusPill>
                  </li>
                ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Always-on journeys"
          description="Automations that can send outside the calendar."
        >
          {!journeys?.length ? (
            <p className="text-sm text-muted-foreground">No journeys defined.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(journeys as Row[]).map((j) => (
                <li
                  key={String(j["id"])}
                  className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                >
                  <span className="font-medium text-foreground">{String(j["name"])}</span>
                  <StatusPill tone={String(j["status"]) === "active" ? "success" : "default"}>
                    {titleCase(String(j["status"]))}
                  </StatusPill>
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
    <OpsGuard path="/marketing/calendar">
      <Page />
    </OpsGuard>
  );
}
