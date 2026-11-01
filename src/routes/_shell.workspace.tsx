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
  displayStations,
  DISPLAY_LABELS,
  DISPLAY_ROUTES,
  type DisplayDepartment,
} from "@/lib/production-displays";
import { supabase } from "@/integrations/supabase/client";
import { useScopedStations } from "@/lib/kitchen-tickets";
import { pairSharedDisplay } from "@/lib/shared-production-display";
import {
  isStaffPinSession,
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
    canExact,
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

  const canPairDisplay =
    isAdmin ||
    canExact("kitchen", "production.manage") ||
    canExact("kitchen", "chef.assign") ||
    canExact("bar", "queue", "assign");

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

  const displayChoices = useMemo<DisplayChoice[]>(() => {
    if (!canPairDisplay) return [];

    return DISPLAY_DEPARTMENTS.map((department) => ({
      department,
      label: DISPLAY_LABELS[department],
      route: DISPLAY_ROUTES[department],
    })).filter((choice) => canAccessPath(can, choice.route));
  }, [can, canPairDisplay]);

  const applyingRequestedProperty = Boolean(
    requestedBranch && activeBranchId !== requestedBranch.id,
  );

  const pinHomeTarget =
    askedForHome &&
    isStaffPinSession() &&
    phase === "ready" &&
    !branchesLoading &&
    !applyingRequestedProperty &&
    activeBranch &&
    workHome.route !== "/workspace"
      ? workHome.route
      : null;

  useEffect(() => {
    if (!pinHomeTarget) return;
    void navigate({ href: pinHomeTarget, replace: true });
  }, [navigate, pinHomeTarget]);

  function enterSystem() {
    const target = workHome.route === "/workspace" ? "/workspace" : workHome.route;
    void navigate({ href: target, replace: true });
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
    if (
      phase !== "ready" ||
      branchesLoading ||
      applyingRequestedProperty ||
      Boolean(pinHomeTarget)
    ) {
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
        propertyId={activeBranch.id}
        propertyName={activeBranch.name}
        displays={displayChoices}
        onEnterSystem={enterSystem}
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
  propertyId,
  propertyName,
  displays,
  onEnterSystem,
  canAuthorizeDevice,
  authorizingDevice,
  onAuthorizeDevice,
}: {
  propertyId: string;
  propertyName: string;
  displays: DisplayChoice[];
  onEnterSystem: () => void;
  canAuthorizeDevice: boolean;
  authorizingDevice: boolean;
  onAuthorizeDevice: () => void;
}) {
  const stationScope = useScopedStations();
  const [selectedDisplay, setSelectedDisplay] =
    useState<DisplayChoice | null>(null);
  const [selectedStationIds, setSelectedStationIds] =
    useState<string[]>([]);
  const [displayLabel, setDisplayLabel] = useState("");
  const [pairingDisplay, setPairingDisplay] = useState(false);

  const availableStations = useMemo(
    () =>
      selectedDisplay
        ? displayStations(
            stationScope.stations,
            selectedDisplay.department,
          )
        : [],
    [selectedDisplay, stationScope.stations],
  );

  function openDisplaySetup(display: DisplayChoice) {
    if (stationScope.isLoading) {
      toast.info("Loading the stations available at this property.");
      return;
    }

    if (stationScope.error) {
      toast.error(stationScope.error.message);
      return;
    }

    const stations = displayStations(
      stationScope.stations,
      display.department,
    );

    if (!stations.length) {
      toast.error(
        `No active ${display.label.toLowerCase()} stations are available at this property.`,
      );
      return;
    }

    setSelectedDisplay(display);
    setSelectedStationIds(
      stations.length === 1 && stations[0] ? [stations[0].id] : [],
    );
    setDisplayLabel(`${propertyName} · ${display.label}`);
  }

  function toggleStation(stationId: string) {
    setSelectedStationIds((current) => {
      if (current.includes(stationId)) {
        return current.filter((id) => id !== stationId);
      }

      if (current.length >= 16) {
        toast.error("A display can contain at most 16 stations.");
        return current;
      }

      return [...current, stationId];
    });
  }

  async function pairDisplayDevice() {
    if (
      !selectedDisplay ||
      !selectedStationIds.length ||
      pairingDisplay
    ) {
      return;
    }

    const permittedIds = new Set(
      availableStations.map((station) => station.id),
    );

    if (
      selectedStationIds.some(
        (stationId) => !permittedIds.has(stationId),
      )
    ) {
      toast.error("Choose stations from the selected display department.");
      return;
    }

    const label = displayLabel.trim();

    if (label.length < 2 || label.length > 80) {
      toast.error("Enter a display name between 2 and 80 characters.");
      return;
    }

    setPairingDisplay(true);

    try {
      await pairSharedDisplay(
        propertyId,
        selectedStationIds,
        label,
        false,
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "This production display could not be paired.",
      );
      setPairingDisplay(false);
    }
  }
  return (
    <main
      data-neo-workspace-entry
      className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6"
    >
      <PageHeader
        eyebrow={propertyName}
        title="Choose how you want to work"
        description="Enter the main NEØ system, configure a standalone production display, or authorise this device for staff PIN sign-in."
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
            disabled={stationScope.isLoading}
            onClick={() => openDisplaySetup(display)}
            className="group flex min-h-48 flex-col items-start rounded-2xl border border-border bg-card p-6 text-left shadow-sm transition hover:border-primary/60 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="grid size-11 place-items-center rounded-xl bg-neo-turquoise/15 text-neo-aqua">
              <Monitor className="size-5" aria-hidden />
            </span>
            <span className="mt-5 text-lg font-semibold text-foreground">
              Set up {display.label}
            </span>
            <span className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Select the relevant stations and pair this computer as an
              independent 12-hour production screen.
            </span>
          </button>
        ))}
      </section>

      {selectedDisplay ? (
        <section
          data-neo-display-device-setup
          className="space-y-5 rounded-2xl border border-neo-turquoise/30 bg-card p-5 shadow-sm"
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neo-aqua">
              Standalone production screen
            </p>
            <h2 className="mt-1 text-lg font-semibold text-foreground">
              Configure {selectedDisplay.label}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              This device will be restricted to the selected property and
              stations. The supervisor account signs out when pairing succeeds.
            </p>
          </div>

          <label className="block space-y-2">
            <span className="text-sm font-medium text-foreground">
              Device name
            </span>
            <input
              value={displayLabel}
              maxLength={80}
              onChange={(event) => setDisplayLabel(event.target.value)}
              className="min-h-11 w-full rounded-xl border border-border bg-background px-4 text-foreground outline-none focus:border-neo-turquoise focus:ring-2 focus:ring-neo-turquoise/20"
            />
          </label>

          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              Stations shown on this display
            </p>

            <div className="grid gap-2 sm:grid-cols-2">
              {availableStations.map((station) => {
                const selected = selectedStationIds.includes(station.id);

                return (
                  <button
                    key={station.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleStation(station.id)}
                    className={`min-h-11 rounded-xl border px-4 text-left text-sm font-medium transition ${
                      selected
                        ? "border-neo-turquoise bg-neo-turquoise/10 text-foreground"
                        : "border-border bg-background text-muted-foreground hover:border-neo-turquoise/60"
                    }`}
                  >
                    {station.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-3">
            <button
              type="button"
              disabled={pairingDisplay}
              onClick={() => {
                setSelectedDisplay(null);
                setSelectedStationIds([]);
                setDisplayLabel("");
              }}
              className="min-h-11 rounded-xl border border-border px-5 text-sm font-semibold text-foreground"
            >
              Cancel
            </button>

            <button
              type="button"
              disabled={
                pairingDisplay ||
                !selectedStationIds.length ||
                displayLabel.trim().length < 2
              }
              onClick={() => void pairDisplayDevice()}
              className="min-h-11 rounded-xl bg-neo-turquoise px-5 text-sm font-semibold text-neo-midnight disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pairingDisplay
                ? "Pairing display…"
                : "Pair and open display"}
            </button>
          </div>
        </section>
      ) : null}

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