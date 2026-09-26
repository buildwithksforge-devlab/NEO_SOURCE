import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Building2,
  Eye,
  Lock,
  ShieldAlert,
  UserCog,
} from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DashboardFrame } from "@/components/dashboard/DashboardFrame";
import { AwaitingData } from "@/components/dashboard/AwaitingData";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { DEFAULT_SCOPE, useScopeOptions, type DashboardScope } from "@/lib/dashboard-data";
import { dashboardSpec } from "@/lib/dashboards";
import { useTenant } from "@/lib/tenant";
import { usePublicWorkspaces } from "@/lib/public-apps-data";
import { withPreview } from "@/lib/preview-mode";
import {
  dashboardKeyForRole,
  defaultPlacementForRole,
  PREVIEW_BLOCKED_ACTIONS,
  PREVIEW_COMBINATIONS,
  PREVIEW_ROLES,
  previewNavigation,
} from "@/lib/workspace-preview";
import { useOrgRoles, useRolePermissions } from "@/lib/workspace-preview-data";

export const Route = createFileRoute("/admin/workspace-preview")({
  head: () => ({
    meta: [
      { title: "Workspace Preview — HOS Administration" },
      {
        name: "description",
        content:
          "Safely preview how each department, station and role workspace looks without changing the administrator's own role or permissions.",
      },
      { property: "og:title", content: "Workspace Preview — HOS Administration" },
      {
        property: "og:description",
        content: "Read-only role, department and station workspace preview for administrators.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: WorkspacePreviewPage,
});

const ALL = "all";

function WorkspacePreviewPage() {
  // Authority is a granted capability, never a role title.
  const { can, roleNames, organizationId, user, profile } = useAuth();
  const mayPreview = can("administration", "workspace", "edit");
  const { tenant } = useTenant();
  const roles = useOrgRoles(Boolean(organizationId));
  const options = useScopeOptions(organizationId);

  const [active, setActive] = useState(false);
  const [roleName, setRoleName] = useState<string>(PREVIEW_ROLES[0]);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [stationId, setStationId] = useState<string | null>(null);
  const [showBlocked, setShowBlocked] = useState(true);

  const roleRow = (roles.data ?? []).find((r) => r.name === roleName) ?? null;
  const rolePerms = useRolePermissions(active ? (roleRow?.id ?? null) : null);
  const permissions = rolePerms.data ?? new Set<string>();

  const branches = options.data?.branches ?? [];
  const departments = (options.data?.departments ?? []).filter(
    (d) => !branchId || d.branch_id === branchId,
  );
  const stations = (options.data?.stations ?? []).filter(
    (s) => !departmentId || s.department_id === departmentId,
  );

  const branchName = branches.find((b) => b.id === branchId)?.name ?? "All branches";
  const departmentName =
    departments.find((d) => d.id === departmentId)?.name ??
    defaultPlacementForRole(roleName).department;
  const stationName =
    stations.find((s) => s.id === stationId)?.name ?? defaultPlacementForRole(roleName).station;

  const key = dashboardKeyForRole(roleName);
  const spec = useMemo(() => dashboardSpec(key), [key]);
  const scope: DashboardScope = { ...DEFAULT_SCOPE, branchId, departmentId, stationId };

  const audit = (action: string, detail: Record<string, unknown>) =>
    void logAudit({
      organizationId,
      userId: user?.id ?? null,
      userName: profile?.full_name ?? "",
      action,
      module: "administration",
      recordId: roleRow?.id ?? null,
      newValue: { role: roleName, branch: branchName, department: departmentName, station: stationName, ...detail },
      reason: "Workspace preview (read-only simulation)",
      branchId,
      departmentId,
    });

  // Log selector changes only while a preview session is running.
  const prev = useRef({ roleName, departmentId, stationId });
  useEffect(() => {
    if (!active) {
      prev.current = { roleName, departmentId, stationId };
      return;
    }
    if (prev.current.roleName !== roleName) audit("preview.role_changed", { from: prev.current.roleName });
    if (prev.current.departmentId !== departmentId) audit("preview.department_changed", {});
    if (prev.current.stationId !== stationId) audit("preview.station_changed", {});
    prev.current = { roleName, departmentId, stationId };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleName, departmentId, stationId, active]);

  const publications = usePublicWorkspaces();
  const guestSlug = (publications.data ?? []).find((w) => w.app_key === "guest")?.slug ?? null;

  if (!mayPreview) {
    return (
      <div>
        <PageHeader
          eyebrow="Administration"
          title="Workspace Preview"
          description="Workspace Preview requires the workspace administration capability."
        />
        <SectionCard title="Access restricted" description="Your effective access does not include workspace administration.">

          <p className="text-sm text-muted-foreground">
            Signed in as {roleNames.join(", ") || "a role without administration rights"}.
          </p>
        </SectionCard>
      </div>
    );
  }

  const navGroups = previewNavigation(permissions, showBlocked);
  const hiddenCount = previewNavigation(permissions, true)
    .flatMap((g) => g.items)
    .filter((i) => !i.allowed).length;

  return (
    <div>
      <PageHeader
        eyebrow="Administration"
        title="Workspace Preview"
        description="See exactly how a department, station or role workspace looks — without changing your own role, assignments or permissions."
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin">
              <ArrowLeft className="size-4" />
              Return to Admin Dashboard
            </Link>
          </Button>
        }
      />

      {active ? (
        <div className="mb-6 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm font-semibold uppercase tracking-wide text-warning">
          <span className="flex flex-wrap items-center gap-2">
            <ShieldAlert className="size-4" />
            Workspace preview mode — no real actions will be processed.
          </span>
        </div>
      ) : null}

      <SectionCard
        title="Guest & Rider app preview"
        description="Open the guest-facing and rider apps in a read-only walkthrough. Preview sessions never create customer, rider or order records."
        className="mb-6"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={!guestSlug}
            onClick={() => {
              if (!guestSlug) return;
              audit("preview.guest_app_opened", { slug: guestSlug });
              window.open(withPreview(`/guest/${guestSlug}`), "_blank", "noopener");
            }}
          >
            Preview Guest app
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              audit("preview.rider_app_opened", {});
              window.open(withPreview("/rider"), "_blank", "noopener");
            }}
          >
            Preview Rider app
          </Button>
          {!guestSlug ? (
            <span className="text-sm text-muted-foreground">
              Guest app not published yet — publish a guest workspace to preview it.
            </span>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="Preview selector"
        description="Choose the organisation, branch, department, station and role to simulate."
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Organization</span>
            <div className="flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm">
              <Building2 className="size-4 text-muted-foreground" />
              <span className="truncate">{tenant.organization.name || "Current organisation"}</span>
            </div>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Branch</span>
            <Select
              value={branchId ?? ALL}
              onValueChange={(v) => {
                setBranchId(v === ALL ? null : v);
                setDepartmentId(null);
                setStationId(null);
              }}
            >
              <SelectTrigger className="h-9" aria-label="Preview branch">
                <SelectValue placeholder="All branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All branches</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Department</span>
            <Select
              value={departmentId ?? ALL}
              onValueChange={(v) => {
                setDepartmentId(v === ALL ? null : v);
                setStationId(null);
              }}
            >
              <SelectTrigger className="h-9" aria-label="Preview department">
                <SelectValue placeholder="All departments" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All departments</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Operational station</span>
            <Select value={stationId ?? ALL} onValueChange={(v) => setStationId(v === ALL ? null : v)}>
              <SelectTrigger className="h-9" aria-label="Preview station">
                <SelectValue placeholder="All stations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All stations</SelectItem>
                {stations.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Role</span>
            <Select value={roleName} onValueChange={setRoleName}>
              <SelectTrigger className="h-9" aria-label="Preview role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PREVIEW_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <div className="flex items-end gap-2">
            {active ? (
              <Button
                variant="outline"
                onClick={() => {
                  setActive(false);
                  audit("preview.ended", {});
                }}
              >
                Exit Preview
              </Button>
            ) : (
              <Button
                onClick={() => {
                  setActive(true);
                  audit("preview.started", {});
                }}
              >
                <Eye className="size-4" />
                Start preview
              </Button>
            )}
            <Button variant="ghost" onClick={() => setShowBlocked((v) => !v)}>
              {showBlocked ? "Hide restricted pages" : "Show restricted pages"}
            </Button>
          </div>
        </div>

        {!active ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Preview is a visual simulation only. It never changes your role, never modifies database
            assignments, and never bypasses row-level security — use an actual staff login (see{" "}
            <Link to="/admin/role-testing" className="text-primary underline">
              Role Testing
            </Link>
            ) to verify real access.
          </p>
        ) : null}
      </SectionCard>

      {active ? (
        <div className="mt-6 space-y-6">
          <SectionCard title="Previewing" description="Selected workspace context">
            <div className="flex flex-wrap gap-2 text-sm">
              {[
                ["Organization", tenant.organization.name || "Current organisation"],
                ["Branch", branchName],
                ["Department", departmentName],
                ["Station", stationName],
                ["Role", roleName],
                ["Dashboard", spec.name],
              ].map(([k, v]) => (
                <span key={k} className="rounded-lg border border-border px-3 py-1.5">
                  <span className="text-muted-foreground">{k}: </span>
                  <span className="font-medium">{v}</span>
                </span>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => document.getElementById("preview-selector-role")?.scrollIntoView()}>
                <UserCog className="size-4" />
                Change Role
              </Button>
              <Button variant="outline" onClick={() => setDepartmentId(null)}>
                Change Department
              </Button>
              <Button variant="outline" onClick={() => setStationId(null)}>
                Change Station
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setActive(false);
                  audit("preview.ended", {});
                }}
              >
                Exit Preview
              </Button>
              <Button variant="ghost" asChild>
                <Link to="/admin">Return to Admin Dashboard</Link>
              </Button>
            </div>
          </SectionCard>

          <div className="grid gap-6 lg:grid-cols-4">
            <div className="lg:col-span-1">
              <SectionCard
                title="Sidebar for this role"
                description={`${permissions.size} permissions configured · ${hiddenCount} pages hidden`}
              >
                {rolePerms.isLoading ? (
                  <p className="text-sm text-muted-foreground">Loading role permissions…</p>
                ) : (
                  <TooltipProvider>
                    <div className="space-y-4">
                      {navGroups.map((g) => (
                        <div key={g.title}>
                          <p className="pb-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                            {g.title}
                          </p>
                          <ul className="space-y-0.5 text-sm">
                            {g.items.map((i) => (
                              <li key={i.to}>
                                {i.allowed ? (
                                  <span className="block rounded-md px-2 py-1">{i.label}</span>
                                ) : (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="flex items-center gap-2 rounded-md px-2 py-1 text-muted-foreground/60 line-through">
                                        <Lock className="size-3" />
                                        {i.label}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      Hidden — requires {i.module}:view
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </TooltipProvider>
                )}
                {permissions.size === 0 && !rolePerms.isLoading ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    This role currently has no permission grants in the database, so only personal
                    pages appear. Configure grants in Roles &amp; Permissions.
                  </p>
                ) : null}
              </SectionCard>
            </div>

            <div className="lg:col-span-3 space-y-6">
              <DashboardFrame
                spec={spec}
                scope={scope}
                onScopeChange={(next) => {
                  setBranchId(next.branchId);
                  setDepartmentId(next.departmentId);
                  setStationId(next.stationId);
                }}
                userId={user?.id ?? null}
                organizationId={organizationId}
                greeting={`${roleName} workspace preview`}
                dashboards={[{ key, name: spec.name }]}
                activeKey={key}
              />

              <SectionCard
                title="Actions blocked in preview"
                description="Explaining the permission each action would need outside preview mode"
              >
                <TooltipProvider>
                  <div className="flex flex-wrap gap-2">
                    {PREVIEW_BLOCKED_ACTIONS.map((a) => (
                      <Tooltip key={a.label}>
                        <TooltipTrigger asChild>
                          <span>
                            <Button variant="outline" disabled>
                              {a.label}
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{a.requires}</TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                </TooltipProvider>
                <p className="mt-3 text-xs text-muted-foreground">
                  Preview never processes payments or refunds, voids bills, approves requests,
                  deletes records, changes stock or sends customer communications.
                </p>
              </SectionCard>

              <AwaitingData
                title="Operational modules for this workspace"
                note="Awaiting operational data — bookings, orders, payments, stock and guest activity appear here once the operational modules are implemented."
              />
            </div>
          </div>
        </div>
      ) : (
        <SectionCard
          className="mt-6"
          title="Department and station coverage"
          description="Combinations available for preview"
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {PREVIEW_COMBINATIONS.map((c) => (
              <div
                key={`${c.department}-${c.station}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <span>{c.department}</span>
                <StatusPill tone="info">{c.station}</StatusPill>
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}
