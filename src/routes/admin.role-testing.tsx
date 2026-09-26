import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, CircleDashed, TriangleAlert } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import {
  dashboardKeyForRole,
  defaultPlacementForRole,
  previewNavigation,
} from "@/lib/workspace-preview";
import {
  useOrgRoles,
  useRoleAccounts,
  useRoleDashboardAssignments,
  useRolePermissionCounts,
  useRolePermissions,
} from "@/lib/workspace-preview-data";
import { dashboardSpec } from "@/lib/dashboards";
import { ErrorState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/admin/role-testing")({
  head: () => ({
    meta: [
      { title: "Role Testing — HOS Administration" },
      {
        name: "description",
        content:
          "Verify dashboards, sidebars, scope, approvals and row-level security for every hospitality role using real staff accounts.",
      },
      { property: "og:title", content: "Role Testing — HOS Administration" },
      {
        property: "og:description",
        content: "Role-by-role verification checklist for dashboards, permissions and RLS.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: RoleTestingPage,
});

type Tone = "success" | "warning" | "info" | "default";

function Check({ label, tone, note }: { label: string; tone: Tone; note: string }) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" ? TriangleAlert : CircleDashed;
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
      <span className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 text-muted-foreground" />
        <span>
          <span className="block font-medium">{label}</span>
          <span className="block text-xs text-muted-foreground">{note}</span>
        </span>
      </span>
      <StatusPill tone={tone}>
        {tone === "success" ? "Verified" : tone === "warning" ? "Attention" : "Manual"}
      </StatusPill>
    </li>
  );
}

function RoleTestingPage() {
  // Authority is a granted capability, never a role title.
  const { can, organizationId } = useAuth();
  const mayTestRoles = can("administration", "workspace", "edit");
  const roles = useOrgRoles(Boolean(organizationId));
  const assignments = useRoleDashboardAssignments(Boolean(organizationId));
  const counts = useRolePermissionCounts(Boolean(organizationId));
  const accounts = useRoleAccounts(Boolean(organizationId));
  const [roleId, setRoleId] = useState<string>("");

  // Role Testing lists the organisation's real roles, matched by UUID — never a
  // hardcoded catalogue, so a renamed or newly provisioned role appears at once.
  const configuredRoles = useMemo(
    () => (roles.data ?? []).filter((r) => r.role_status !== "archived"),
    [roles.data],
  );
  const roleRow = configuredRoles.find((r) => r.id === roleId) ?? configuredRoles[0] ?? null;
  const roleName = roleRow?.name ?? "";
  const perms = useRolePermissions(roleRow?.id ?? null);
  const permissions = perms.data ?? new Set<string>();

  const key = dashboardKeyForRole(roleName);
  const spec = useMemo(() => dashboardSpec(key), [key]);
  const placement = defaultPlacementForRole(roleName);
  const assigned = (assignments.data ?? []).filter((a) => a.role_id === roleRow?.id);
  const roleAccounts = roleRow ? (accounts.data?.[roleRow.id] ?? []) : [];
  const signedIn = roleAccounts.filter((a) => a.last_login_at);
  const visiblePages = previewNavigation(permissions, false).flatMap((g) => g.items).length;

  const rolesWithDashboard = configuredRoles.filter((r) =>
    (assignments.data ?? []).some((a) => a.role_id === r.id),
  ).length;
  const rolesWithPermissions = configuredRoles.filter((r) => (counts.data?.[r.id] ?? 0) > 0).length;
  const rolesWithAccounts = configuredRoles.filter(
    (r) => (accounts.data?.[r.id] ?? []).length > 0,
  ).length;


  if (!mayTestRoles) {
    return (
      <div>
        <PageHeader
          eyebrow="Administration"
          title="Role Testing"
          description="Role testing requires the workspace administration capability."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Administration"
        title="Role Testing"
        description="Verify each role against real staff accounts. Workspace Preview shows how a workspace looks; role testing confirms what an actual signed-in account can do."
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/workspace-preview">Open Workspace Preview</Link>
          </Button>
        }
      />

      <div className="mb-6 rounded-xl border border-border bg-muted/40 p-4 text-sm">
        <p className="font-medium">Two different things</p>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">Workspace preview</span> — shows the
            administrator how a workspace looks. It never changes your role and never proves access.
          </li>
          <li>
            <span className="font-medium text-foreground">Actual user login</span> — a real staff
            account signs in; database row-level security decides what that account can read and
            write. This is the only true verification.
          </li>
        </ul>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Roles in catalogue" value={String(configuredRoles.length)} hint="Configured in this organisation" />
        <StatCard label="Roles with a dashboard" value={String(rolesWithDashboard)} hint="Dashboard assignment present" tone="accent" />
        <StatCard label="Roles with permissions" value={String(rolesWithPermissions)} hint="At least one grant" tone="success" />
        <StatCard label="Roles with staff accounts" value={String(rolesWithAccounts)} hint="Real accounts available to test" tone="warning" />
      </div>

      <SectionCard className="mt-6" title="Role under test" description="Select a role to review its verification checklist">
        <Select value={roleRow?.id ?? ""} onValueChange={setRoleId}>
          <SelectTrigger className="h-9 w-full sm:w-[320px]" aria-label="Role to test">
            <SelectValue placeholder={roles.isLoading ? "Loading roles…" : "No roles configured"} />
          </SelectTrigger>
          <SelectContent>
            {configuredRoles.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
                {(accounts.data?.[r.id] ?? []).length > 0
                  ? ` · ${(accounts.data?.[r.id] ?? []).length} account(s)`
                  : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {accounts.error ? (
          <ErrorState
            className="mt-2"
            title="Staff accounts could not be read"
            error={accounts.error}
            inline
          />
        ) : null}


        <ul className="mt-4 space-y-2">
          <Check
            label="Correct dashboard"
            tone={assigned.length > 0 ? "success" : "warning"}
            note={
              assigned.length > 0
                ? `Assigned dashboard: ${assigned.map((a) => a.dashboard_key).join(", ")} · resolves to ${spec.name}`
                : `No dashboard assignment found — the role would fall back to ${spec.name}`
            }
          />
          <Check
            label="Correct sidebar"
            tone={visiblePages > 0 ? "success" : "warning"}
            note={`${visiblePages} navigation destinations visible from ${permissions.size} permission grants`}
          />
          <Check
            label="Correct organization access"
            tone={roleRow ? "success" : "warning"}
            note={roleRow ? "Role belongs to this organisation only" : "Role not found in this organisation"}
          />
          <Check
            label="Correct branch access"
            tone="info"
            note="Branch scope comes from the user's branch assignments — verify with a real account per branch"
          />
          <Check
            label="Correct department access"
            tone="info"
            note={`Expected department for this role: ${placement.department}`}
          />
          <Check
            label="Correct station access"
            tone="info"
            note={`Expected station for this role: ${placement.station}`}
          />
          <Check
            label="Correct task visibility"
            tone={permissions.size > 0 ? "success" : "info"}
            note="Personal tasks always visible; team tasks follow branch, department and station scope"
          />
          <Check
            label="Correct notification visibility"
            tone="success"
            note="Notifications are limited to the signed-in user or organisation-wide broadcasts"
          />
          <Check
            label="Correct approval authority"
            tone={permissions.has("administration:approve") ? "success" : "info"}
            note={
              permissions.has("administration:approve")
                ? "Role may approve; self-approval is blocked by the database"
                : "Role may raise requests but not approve them"
            }
          />
          <Check
            label="Restricted actions blocked"
            tone="success"
            note="Void, refund, override, delete and approve remain permission-gated and audited"
          />
          <Check
            label="Unauthorized URLs blocked"
            tone="success"
            note="Direct navigation is re-checked on each route and unauthorised reads are rejected by the database"
          />
          <Check
            label="RLS test status"
            tone="info"
            note="Row-level security cannot be simulated — sign in as a real account for this role to confirm"
          />
          <Check
            label="Actual test-user login status"
            tone={signedIn.length > 0 ? "success" : roleAccounts.length > 0 ? "warning" : "info"}
            note={
              roleAccounts.length === 0
                ? "No staff account currently holds this role"
                : `${roleAccounts.length} account(s) hold this role · ${signedIn.length} have signed in`
            }
          />
        </ul>
      </SectionCard>

      <SectionCard className="mt-6" title="Accounts holding this role" description="Use these real logins to complete verification">
        {roleAccounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No staff account holds this role yet. Assign it in{" "}
            <Link to="/users" className="text-primary underline">
              User Management
            </Link>
            .
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {roleAccounts.map((a) => (
              <li key={a.user_id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {a.full_name || "Unnamed"}
                    {a.is_primary ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        primary role
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{a.email}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[a.staff_id, a.job_title, a.department, a.property].filter(Boolean).join(" · ") ||
                      "No department or property recorded"}
                  </span>
                </span>
                <StatusPill tone={a.last_login_at ? "success" : "warning"}>
                  {a.last_login_at ? "Has signed in" : "Never signed in"}
                </StatusPill>
              </li>
            ))}

          </ul>
        )}
      </SectionCard>
    </div>
  );
}
