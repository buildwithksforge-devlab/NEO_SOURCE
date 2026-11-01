import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, Monitor, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { resolveWorkHome } from "@/lib/work-home";
import { canAccessPath } from "@/lib/nav-permissions";
import { DashboardFrame } from "@/components/dashboard/DashboardFrame";
import { WorkplaceSetupNotice } from "@/components/dashboard/WorkplaceSetupNotice";
import { ClockDock } from "@/components/hr/ClockDock";
import { useAuth } from "@/lib/auth";
import { useBranchScope } from "@/lib/branches";
import {
  DEFAULT_SCOPE,
  useDashboardRealtime,
  useMyDashboards,
  type DashboardScope,
} from "@/lib/dashboard-data";
import { dashboardSpec } from "@/lib/dashboards";
import { greetingFor } from "@/lib/greeting";
import { MobileWorkToday } from "@/components/layout/MobileWorkToday";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { PageHeader } from "@/components/common/DataDisplay";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DISPLAY_LABELS,
  DISPLAY_ROUTES,
  type DisplayDepartment,
} from "@/lib/production-displays";
import { supabase } from "@/integrations/supabase/client";
import {
  pairTrustedStaffDevice,
  revokeTrustedStaffDevice,
} from "@/lib/staff-pin-login";

type WorkspaceSearch = {
  home?: "1";
  property?: string;
};

const DISPLAY_DEPARTMENTS = ["kitchen", "coffee", "bar", "pastry"] as const;

type DisplayChoice = {
  department: Exclude<DisplayDepartment, "overview">;
  label: string;
  route: string;
};

export const Route = createFileRoute("/_shell/workspace")({
  validateSearch: (search: Record<string, unknown>): WorkspaceSearch => {
    const home = String(search["home"] ?? "") === "1" ? "1" : undefined;
    const property =
      typeof search["property"] === "string" && search["property"].trim()
        ? search["property"].trim()
        : undefined;

    return {
      ...(home ? { home } : {}),
      ...(property ? { property } : {}),
    };
  },
  head: () => ({
    meta: [
      { title: "Operations Dashboard — NEØ Hospitality Platform" },
      {
        name: "description",
        content:
          "Personalised, role-based operational dashboards with live tasks, approvals, alerts and KPIs across your hospitality organisation.",
      },
      {
        property: "og:title",
        content: "Operations Dashboard — NEØ Hospitality Platform",
      },
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
  const {
    profile,
    organizationId,
    user,
    access,
    canModule,
    can,
    phase,
    isAdmin,
  } = useAuth();
  const {
    branches,
    activeBranchId,
    loading: branchesLoading,
    setActiveBranchId,
  } = useBranchScope();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const askedForHome = search.home === "1";
  const requestedProperty = search.property ?? null;
  const [authorizingDevice, setAuthorizingDevice] = useState(false);

  const canAuthorizeDevice =
    isAdmin ||
    can("administration", "users", "manage") ||
    can("administration", "users", "invite") ||
    can("administration", "users", "assign_roles");

  const requestedBranch = useMemo(
    () =>
      requestedProperty
        ? branches.find((branch) => branch.id === requestedProperty) ?? null
        : null,
    [branches, requestedProperty],
  );

  useEffect(() => {
    if (
      !askedForHome ||
      branchesLoading ||
      !requestedBranch ||
      activeBranchId === requestedBranch.id
    ) {
      return;
    }

    setActiveBranchId(requestedBranch.id);
  }, [
    activeBranchId,
    askedForHome,
    branchesLoading,
    requestedBranch,
    setActiveBranchId,
  ]);

  const activeBranch = useMemo(() => {
    if (requestedBranch) return requestedBranch;
    if (!activeBranchId || activeBranchId === "all") return null;
    return branches.find((branch) => branch.id === activeBranchId) ?? null;
  }, [activeBranchId, branches, requestedBranch]);

  const workHome = useMemo(
    () =>
      resolveWorkHome({
        accessScope: access.accessScope,
        dashboardKey: access.dashboardKey,
        canModule,
        canOpen: (route) => canAccessPath(can, route),
      }),
    [access.accessScope, access.dashboardKey, canModule, can],
  );

  const displayChoices = useMemo<DisplayChoice[]>(
    () =>
      DISPLAY_DEPARTMENTS.map((department) => ({
        department,
        label: DISPLAY_LABELS[department],
        route: DISPLAY_ROUTES[department],
      })).filter((choice) => canAccessPath(can, choice.route)),
    [can],
  );

  const applyingRequestedProperty = Boolean(
    requestedBranch && activeBranchId !== requestedBranch.id,
  );

  function enterSystem() {
    const target = workHome.route === "/workspace" ? "/workspace" : workHome.route;
    void navigate({ href: target, replace: true });
  }

  function openDisplay(route: string) {
    void navigate({ href: route });
  }

  async function authorizeThisDevice() {
    if (!activeBranch || authorizingDevice) return;

    const confirmed = window.confirm(
      `Authorise this browser for staff PIN sign-in at ${activeBranch.name}? ` +
        "Your administrator account will be signed out when authorisation succeeds.",
    );

    if (!confirmed) return;

    setAuthorizingDevice(true);

    try {
      await pairTrustedStaffDevice(
        activeBranch.id,
        `${activeBranch.name} shared staff device`,
      );

      const { error } = await supabase.auth.signOut({
        scope: "local",
      });

      if (error) {
        await revokeTrustedStaffDevice().catch(() => undefined);
        throw error;
      }

      window.location.replace("/auth?mode=pin");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "This device could not be authorised.",
      );
      setAuthorizingDevice(false);
    }
  }

  if (askedForHome) {
    if (phase !== "ready" || branchesLoading || applyingRequestedProperty) {
      return <Skeleton className="mx-auto mt-8 h-72 w-full max-w-5xl" />;
    }

    if (requestedProperty && !requestedBranch) {
      return (
        <AccessDeniedPanel
          reason="scope"
          subject="the selected property"
          detail="This property is not available within your current staff access."
        />
      );
    }

    if (!activeBranch) {
      return (
        <AccessDeniedPanel
          reason="setup"
          subject="a work property"
          detail="Choose one property from the property selector before opening NEØ or a station display."
        />
      );
    }

    return (
      <WorkspaceEntrance
        propertyName={activeBranch.name}
        displays={displayChoices}
        onEnterSystem={enterSystem}
        onOpenDisplay={openDisplay}
        canAuthorizeDevice={canAuthorizeDevice}
        authorizingDevice={authorizingDevice}
        onAuthorizeDevice={authorizeThisDevice}
      />
    );
  }

  const dashboards = useMyDashboards(Boolean(organizationId));
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
        dashboards={list.map((dashboard) => ({
          key: dashboard.key,
          name: dashboard.name,
        }))}
        activeKey={activeKey}
      />
      <ClockDock />
    </>
  );
}

function WorkspaceEntrance({
  propertyName,
  displays,
  onEnterSystem,
  onOpenDisplay,
  canAuthorizeDevice,
  authorizingDevice,
  onAuthorizeDevice,
}: {
  propertyName: string;
  displays: DisplayChoice[];
  onEnterSystem: () => void;
  onOpenDisplay: (route: string) => void;
  canAuthorizeDevice: boolean;
  authorizingDevice: boolean;
  onAuthorizeDevice: () => void;
}) {
  return (
    <main
      data-neo-workspace-entry
      className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6"
    >
      <PageHeader
        eyebrow={propertyName}
        title="Choose how you want to work"
        description="Enter the main NEØ system or open a production display available to your role and assigned stations."
      />

      <section
        aria-label="Available workspaces"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        <button
          type="button"
          onClick={onEnterSystem}
          className="group flex min-h-48 flex-col items-start rounded-2xl border border-border bg-card p-6 text-left shadow-sm transition hover:border-primary/60 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
            <LayoutDashboard className="size-5" aria-hidden />
          </span>
          <span className="mt-5 text-lg font-semibold text-foreground">
            Enter NEØ System
          </span>
          <span className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Open your normal role-based workspace, tasks and permitted modules.
          </span>
        </button>

        {displays.map((display) => (
          <button
            key={display.department}
            type="button"
            onClick={() => onOpenDisplay(display.route)}
            className="group flex min-h-48 flex-col items-start rounded-2xl border border-border bg-card p-6 text-left shadow-sm transition hover:border-primary/60 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="grid size-11 place-items-center rounded-xl bg-neo-turquoise/15 text-neo-aqua">
              <Monitor className="size-5" aria-hidden />
            </span>
            <span className="mt-5 text-lg font-semibold text-foreground">
              {display.label}
            </span>
            <span className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Open the stations permitted for this property. Authorized supervisors
              can pair the device for staff PIN operation.
            </span>
          </button>
        ))}
      </section>

      {canAuthorizeDevice ? (
        <section
          data-neo-trusted-device-setup
          className="rounded-2xl border border-neo-turquoise/30 bg-neo-turquoise/5 p-5"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-neo-turquoise/15 text-neo-aqua">
                <ShieldCheck className="size-5" aria-hidden />
              </span>

              <div>
                <h2 className="font-semibold text-foreground">
                  Staff PIN sign-in for this device
                </h2>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                  Authorise this browser for {propertyName}. When setup succeeds,
                  your administrator account signs out and the PIN login opens.
                </p>
              </div>
            </div>

            <button
              type="button"
              disabled={authorizingDevice}
              onClick={onAuthorizeDevice}
              className="min-h-11 shrink-0 rounded-xl bg-neo-turquoise px-5 text-sm font-semibold text-neo-midnight transition hover:bg-neo-aqua hover:text-neo-white disabled:cursor-wait disabled:opacity-60"
            >
              {authorizingDevice
                ? "Authorising…"
                : "Authorise this device"}
            </button>
          </div>
        </section>
      ) : null}

      <p className="text-sm text-muted-foreground">
        Display choices are filtered by your permissions. Station scope and every
        ticket action are checked again by the server.
      </p>
    </main>
  );
}