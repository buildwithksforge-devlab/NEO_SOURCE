import { useMemo, useState } from "react";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { DashboardFrame } from "@/components/dashboard/DashboardFrame";
import { useAuth } from "@/lib/auth";
import { DEFAULT_SCOPE, useMyDashboards, type DashboardScope } from "@/lib/dashboard-data";
import { dashboardSpec } from "@/lib/dashboards";
import { greetingFor } from "./_shell.workspace";
import { LoadingState, NotAuthorisedState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/dashboards/$key")({
  head: () => ({
    meta: [
      { title: "Role Dashboard — HOS Hospitality Platform" },
      {
        name: "description",
        content:
          "Open a department, station or executive dashboard your roles authorise, with live tasks, approvals, alerts and KPIs.",
      },
      { property: "og:title", content: "Role Dashboard — HOS Hospitality Platform" },
      {
        property: "og:description",
        content: "Department, station and executive dashboards scoped to your roles.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: RoleDashboard,
});

function RoleDashboard() {
  const { key } = useParams({ from: "/_shell/dashboards/$key" });
  const { profile, organizationId, user } = useAuth();
  const dashboards = useMyDashboards(Boolean(organizationId));
  const [scope, setScope] = useState<DashboardScope>(DEFAULT_SCOPE);

  const list = dashboards.data ?? [];
  const allowed = list.some((d) => d.key === key);
  const spec = useMemo(() => dashboardSpec(key), [key]);

  if (dashboards.isLoading) {
    return <LoadingState rows={5} />;
  }

  if (!allowed) {
    return (
      <div>
        <PageHeader eyebrow="Dashboards" title="Dashboard not available" description="" />
        <NotAuthorisedState
          subject="this dashboard"
          detail="Your roles do not grant access to this dashboard, or it is not enabled for your organisation."
        />
        <div className="mt-4 flex justify-center">
          <Button asChild>
            <Link to="/workspace">Back to my dashboard</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <DashboardFrame
      spec={spec}
      scope={scope}
      onScopeChange={setScope}
      userId={user?.id ?? null}
      organizationId={organizationId}
      greeting={greetingFor(profile?.full_name ?? "there")}
      dashboards={list.map((d) => ({ key: d.key, name: d.name }))}
      activeKey={key}
    />
  );
}
