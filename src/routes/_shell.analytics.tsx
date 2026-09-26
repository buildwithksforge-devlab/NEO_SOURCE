import { Link, Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { SectionTabs } from "@/components/common/SectionTabs";
import { PageHeader } from "@/components/common/DataDisplay";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { canAccessPath } from "@/lib/nav-permissions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_shell/analytics")({
  head: () => ({
    meta: [
      { title: "Intelligence & Analytics — HOS Hospitality Platform" },
      {
        name: "description",
        content:
          "Governed KPIs, forecasts, risk detection and AI decision support built only from authorised operational records.",
      },
      { property: "og:title", content: "Intelligence & Analytics — HOS Hospitality Platform" },
      {
        property: "og:description",
        content:
          "Governed KPIs, forecasts, risk detection and AI decision support for hospitality operations.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AnalyticsLayout,
});

type Tab = { to: string; label: string; module: string; action: string };

const TABS: Tab[] = [
  { to: "/analytics", label: "Executive", module: "analytics", action: "view" },
  { to: "/analytics/catalogue", label: "KPI Catalogue", module: "analytics", action: "view" },
];

function AnalyticsLayout() {
  const { can } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const visible = TABS.filter((t) => canAccessPath(can, t.to));

  if (visible.length === 0) {
    return (
      <div className="p-6">
        <Card className="border-destructive/40">
          <CardContent className="flex items-start gap-3 py-6">
            <span className="rounded-lg bg-destructive/15 p-2 text-destructive">
              <ShieldAlert className="size-4" />
            </span>
            <div>
              <p className="text-sm font-semibold text-foreground">
                Analytics access is not enabled for your role
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Intelligence &amp; Analytics is permission-controlled. Ask an administrator to grant
                the analytics module to your role. Nothing is shown here without that permission.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Intelligence"
        title="Intelligence & Analytics"
        description="Every figure below is calculated from authorised operational records for your scope. Forecasts and AI commentary are clearly labelled and never presented as recorded fact."
      />
      <SectionTabs tabs={visible} rootPath="/analytics" />
      <Outlet />
    </div>
  );
}
