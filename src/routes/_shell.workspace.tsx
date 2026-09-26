import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { resolveWorkHome } from "@/lib/work-home";
import { canAccessPath } from "@/lib/nav-permissions";
import { DashboardFrame } from "@/components/dashboard/DashboardFrame";
import { WorkplaceSetupNotice } from "@/components/dashboard/WorkplaceSetupNotice";
import { ClockDock } from "@/components/hr/ClockDock";
import { useAuth } from "@/lib/auth";
import {
  DEFAULT_SCOPE,
  useDashboardRealtime,
  useMyDashboards,
  type DashboardScope,
} from "@/lib/dashboard-data";
import { dashboardSpec } from "@/lib/dashboards";
import { greetingFor } from "@/lib/greeting";
import { MobileWorkToday } from "@/components/layout/MobileWorkToday";

export const Route = createFileRoute("/_shell/workspace")({
  head: () => ({
    meta: [
      { title: "Operations Dashboard — HOS Hospitality Platform" },
      {
        name: "description",
        content:
          "Personalised, role-based operational dashboards with live tasks, approvals, alerts and KPIs across your hospitality organisation.",
      },
      { property: "og:title", content: "Operations Dashboard — HOS Hospitality Platform" },
      {
        property: "og:description",
        content:
          "Personalised, role-based operational dashboards with live tasks, approvals, alerts and KPIs.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

export { greetingFor } from "@/lib/greeting";

function Dashboard() {
  const { profile, organizationId, user, access, canModule, can, phase } = useAuth();
  const navigate = useNavigate();
  const sentHome = useRef(false);
  // Sign-in asks for the work home ("?home=1"). Everything else — the sidebar,
  // a bookmark, a back button — opens the dashboard itself, untouched.
  const askedForHome =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("home") === "1";

  useEffect(() => {
    if (!askedForHome || sentHome.current || phase !== "ready") return;
    sentHome.current = true;
    const home = resolveWorkHome({
      accessScope: access.accessScope,
      dashboardKey: access.dashboardKey,
      canModule,
      // Only land somebody on a screen that will actually open for them.
      canOpen: (route) => canAccessPath(can, route),
    });
    navigate({ href: home.route === "/workspace" ? "/workspace" : home.route, replace: true });
  }, [askedForHome, phase, access.accessScope, access.dashboardKey, canModule, can, navigate]);

  const dashboards = useMyDashboards(Boolean(organizationId));
  // Counts follow record state: any change to the tables behind these figures
  // refreshes them immediately, without a manual reload.
  useDashboardRealtime(Boolean(organizationId));
  const [scope, setScope] = useState<DashboardScope>(() => ({
    ...DEFAULT_SCOPE,
    branchId: null,
  }));

  const list = dashboards.data ?? [];
  const activeKey = list[0]?.key ?? "staff";
  const spec = useMemo(() => dashboardSpec(activeKey), [activeKey]);

  return (
    <>
      <WorkplaceSetupNotice />
      <MobileWorkToday />
      <DashboardFrame
        spec={spec}
        scope={scope}
        onScopeChange={setScope}
        userId={user?.id ?? null}
        organizationId={organizationId}
        greeting={greetingFor(profile?.full_name ?? "there")}
        dashboards={list.map((d) => ({ key: d.key, name: d.name }))}
        activeKey={activeKey}
      />
      <ClockDock />
    </>
  );
}
