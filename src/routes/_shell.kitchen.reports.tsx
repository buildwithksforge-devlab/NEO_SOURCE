import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { titleCase, type Row } from "@/lib/kitchen";
import { useKitchenHandovers } from "@/lib/kitchen-data";

export const Route = createFileRoute("/_shell/kitchen/reports")({
  head: () => ({
    meta: [
      { title: "Kitchen reports & handovers — NEØ" },
      {
        name: "description",
        content: "Shift handovers and closing records used for kitchen performance reporting.",
      },
      { property: "og:title", content: "Kitchen reports & handovers — NEØ" },
      {
        property: "og:description",
        content: "Shift handovers and closing records used for kitchen performance reporting.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <KitchenGuard action="reports.view">
      <Page />
    </KitchenGuard>
  ),
});

function Page() {
  const query = useKitchenHandovers();
  const rows = (query.data ?? []) as Row[];
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Kitchen"
        title="Kitchen reports & handovers"
        description="Shift handovers and closing records used for kitchen performance reporting."
      />
      <SectionCard
        title="Kitchen reports & handovers"
        description="Records captured by your kitchen team. Nothing here is simulated."
      >
        <QueryState
          isLoading={query.isLoading}
          error={query.error}
          isEmpty={rows.length === 0}
          empty={<p className="py-6 text-sm text-muted-foreground">No records yet.</p>}
        >
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r["id"]} className="flex items-start justify-between gap-3 py-3 text-sm">
                <div>
                  <p className="font-medium">{`${titleCase(String(r["shift"] ?? "Shift"))} handover`}</p>
                  <p className="text-xs text-muted-foreground">{`${r["operational_stations"]?.name ?? "Kitchen"} · ${r["notes"] ?? ""}`}</p>
                </div>
                <StatusPill tone="default">
                  {titleCase(String(r["status"] ?? "recorded"))}
                </StatusPill>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>
    </div>
  );
}
