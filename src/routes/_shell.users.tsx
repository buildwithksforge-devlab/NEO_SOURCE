import { guardedRpc } from "@/lib/rpc-guard";
import { useEffect, useMemo, useState } from "react";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Loader2, MoreHorizontal, Plus, Search, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { NeoDatePicker, NeoDateRangePicker } from "@/components/common/DatePicker";
import { Avatar } from "@/components/common/AvatarDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useScopedDepartments, useScopedStations } from "@/lib/scoped-options";
import {
  normaliseStaffAccountInput,
  validateStaffAccountInput,
} from "@/lib/staff-account-input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import {
  assignOwnerRole,
  clearStaffPasswordRequirement,
  createStaffUser,
  deleteStaffAccount,
  getStaffSecurityMetadata,
  offboardStaffAccount,
  removeOwnerRole,
  requireStaffPasswordChange,
  resendStaffInvitation,
  resetStaffMfa,
  resetStaffPassword,
  revokeStaffSessions,
  setStaffAccountStatus,
  setUserPermissionOverride,
  updateStaffAssignment,
} from "@/lib/users.functions";
import {
  buildUserActionMenu,
  copyableAccountDetails,
  USER_ACTIONS,
  type UserAction,
  type UserActionTarget,
} from "@/lib/user-actions";
import {
  accountActionImpact,
  mfaStateFromFactors,
  mfaWorkflow,
  passwordWorkflow,
  type MfaState,
} from "@/lib/account-impact";
import {
  auditActionLabel,
  auditFieldDiff,
  AUDIT_CATEGORY_LABELS,
  AUDIT_CATEGORY_ORDER,
  classifyAuditAction,
  filterAuditRows,
  type AuditCategory,
  type AuditRow,
} from "@/lib/audit-history";
import { useSetStaffPhoto } from "@/lib/staff-photos";

import { EmptyState, ErrorState, LoadingState } from "@/components/common/StateSystem";
import {
  departmentsForBranch,
  isDepartmentValidForBranch,
  pruneRoleIds,
  rolesForDepartment,
  type CatalogueScope,
  type ScopedDepartment,
  type ScopedRole,
} from "@/lib/role-scoping";
import {
  RECORD_SCOPE_LABELS,
  resolveAssignmentChain,
  requiresStation,
} from "@/lib/assignment-chain";
import { auditWindowFrom } from "@/lib/audit-window";

export const Route = createFileRoute("/_shell/users")({
  head: () => ({
    meta: [
      { title: "Users — NEØ" },
      {
        name: "description",
        content: "Create staff accounts, assign branches, departments and roles.",
      },
      { property: "og:title", content: "Users — NEØ" },
      {
        property: "og:description",
        content: "Create staff accounts, assign branches, departments and roles.",
      },
    ],
  }),
  component: GuardedPage,
});

const statusTone = (status: string) =>
  status === "active" ? "success" : status === "suspended" ? "destructive" : "warning";

function UsersPage() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId, isAdmin, can, user } = useAuth();
  // Every control is offered only when the exact capability is effective; the
  // organisation-admin flag is a fallback so an Owner is never locked out.
  const allow = (action: string) => can("administration", "users", action) || isAdmin;
  const canView = allow("view");
  const canEdit = allow("edit");
  const canCreate = allow("create");
  const canStatus = allow("manage_status");
  const canAssign =
    canEdit ||
    allow("assign_role") ||
    allow("assign_property") ||
    allow("assign_department") ||
    allow("assign_station") ||
    allow("transfer");
  const canResetAuth = allow("reset_auth");
  const canRequirePassword = allow("require_password_change");
  const canResendInvitation = allow("resend_invitation");
  const canOverride = allow("override_permission");
  const canViewAccess = allow("view_access") || canView;
  const canViewAudit = can("administration", "audit-logs", "view") || isAdmin;
  // One canonical capability decides Owner assignment — never a role name,
  // job title or email address.
  const canAssignOwner = can("administration", "users", "assign_owner");
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [deptFilter, setDeptFilter] = useState("all");
  const [branchFilter, setBranchFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [accessId, setAccessId] = useState<string | null>(null);
  const [overrideId, setOverrideId] = useState<string | null>(null);
  const [auditId, setAuditId] = useState<string | null>(null);
  const createUserFn = useServerFn(createStaffUser);
  const setStatusFn = useServerFn(setStaffAccountStatus);
  const requirePasswordFn = useServerFn(requireStaffPasswordChange);
  const resendInvitationFn = useServerFn(resendStaffInvitation);
  const overrideFn = useServerFn(setUserPermissionOverride);
  const resetPasswordFn = useServerFn(resetStaffPassword);
  const updateAssignmentFn = useServerFn(updateStaffAssignment);
  const assignOwnerFn = useServerFn(assignOwnerRole);
  const removeOwnerFn = useServerFn(removeOwnerRole);

  const usersQuery = useQuery({
    queryKey: ["profiles", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase.from("profiles").select("*, branches(name), departments(name)"),
        "profiles",
      ).order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const rolesQuery = useQuery({
    queryKey: ["roles", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("roles")
        .select("id, name, access_scope, department_id, normalized_role_key, role_status, active")
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as ScopedRole[];
    },
  });

  const roleScopeQuery = useQuery({
    queryKey: ["role-catalogue-scope", filterKey],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_catalogue" as never)
        .select("role_key, department, access_scope, retired");
      if (error) throw error;
      return (data ?? []) as unknown as CatalogueScope[];
    },
  });

  const branchesQuery = useQuery({
    queryKey: ["branches", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase.from("branches").select("id, name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const deptQuery = useScopedDepartments();

  const stationsQuery = useScopedStations();

  const userRolesQuery = useQuery({
    queryKey: ["user-roles", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("user_id, role_id, roles(name)");
      if (error) throw error;
      return data ?? [];
    },
  });

  const userStationsQuery = useQuery({
    queryKey: ["user-stations", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase.from("user_stations").select("user_id, station_id");
      if (error) throw error;
      return data ?? [];
    },
  });

  /**
   * The reporting line is stored on the staff account itself. Eligible
   * managers are resolved live from the canonical role catalogue inside the
   * edit dialog, so the candidate list follows whatever roles, department and
   * property are currently selected.
   */
  const managerProfileByUser = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of (usersQuery.data ?? []) as unknown as {
      id: string;
      reporting_manager_id: string | null;
    }[]) {
      if (row.reporting_manager_id) map.set(row.id, row.reporting_manager_id);
    }
    return map;
  }, [usersQuery.data]);

  const roleIdsByUser = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of userRolesQuery.data ?? []) {
      const r = row as unknown as { user_id: string; role_id: string };
      map.set(r.user_id, [...(map.get(r.user_id) ?? []), r.role_id]);
    }
    return map;
  }, [userRolesQuery.data]);

  const stationByUser = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of (userStationsQuery.data ?? []) as { user_id: string; station_id: string }[]) {
      if (!map.has(row.user_id)) map.set(row.user_id, row.station_id);
    }
    return map;
  }, [userStationsQuery.data]);

  const rolesByUser = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of userRolesQuery.data ?? []) {
      const r = row as unknown as { user_id: string; roles: { name: string } | null };
      const list = map.get(r.user_id) ?? [];
      if (r.roles?.name) list.push(r.roles.name);
      map.set(r.user_id, list);
    }
    return map;
  }, [userRolesQuery.data]);

  const filtered = (usersQuery.data ?? []).filter((u) => {
    const row = u as unknown as {
      id: string;
      full_name: string;
      email: string;
      phone: string;
      staff_id: string;
      job_title: string;
      account_status: string;
      employment_status: string;
      branch_id: string | null;
      department_id: string | null;
    };
    const q = search.trim().toLowerCase();
    const matchesSearch =
      !q ||
      [row.full_name, row.email, row.phone, row.staff_id, row.job_title]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q));
    const roles = rolesByUser.get(row.id) ?? [];
    return (
      matchesSearch &&
      (roleFilter === "all" || roles.includes(roleFilter)) &&
      (deptFilter === "all"
        ? true
        : deptFilter === "none"
          ? !row.department_id
          : row.department_id === deptFilter) &&
      (branchFilter === "all"
        ? true
        : branchFilter === "org"
          ? !row.branch_id
          : row.branch_id === branchFilter) &&
      (statusFilter === "all" || row.account_status === statusFilter) &&
      (typeFilter === "all" || (row.employment_status || "unspecified") === typeFilter)
    );
  });

  const statusMutation = useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: string;
      status: "active" | "inactive" | "suspended";
    }) => {
      await setStatusFn({ data: { user_id: id, status } });
    },
    onSuccess: () => {
      toast.success("Account status updated");
      void qc.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /**
   * Account administration surface.
   *
   * The menu is rendered from the declarative catalogue in `user-actions.ts`, so
   * the controls a person sees are exactly the ones their capabilities allow and
   * the record's state supports. Consequential actions route through a
   * confirmation dialog that collects a reason (and, for a password reset, a new
   * temporary password) before the audited server function runs. The existing
   * password is never read or displayed — it can only be replaced.
   */
  const canFor = (module: string, feature: string, action?: string) =>
    can(module, feature, action ?? "view");
  const [pending, setPending] = useState<{
    action: UserAction;
    target: UserActionTarget;
  } | null>(null);
  const [securityTarget, setSecurityTarget] = useState<UserActionTarget | null>(null);
  const [photoTargetId, setPhotoTargetId] = useState<string | null>(null);
  const clearRequirementFn = useServerFn(clearStaffPasswordRequirement);
  const revokeSessionsFn = useServerFn(revokeStaffSessions);
  const resetMfaFn = useServerFn(resetStaffMfa);
  const offboardFn = useServerFn(offboardStaffAccount);
  const deleteAccountFn = useServerFn(deleteStaffAccount);

  const refreshUsers = () => {
    void qc.invalidateQueries({ queryKey: ["profiles"] });
    void qc.invalidateQueries({ queryKey: ["user-roles"] });
    void qc.invalidateQueries({ queryKey: ["user_roles"] });
  };

  function startAction(action: UserAction, target: UserActionTarget) {
    switch (action.id) {
      case "view_profile":
        setAccessId(target.id);
        return;
      case "view_audit":
        setAuditId(target.id);
        return;
      case "view_security":
        setSecurityTarget(target);
        return;
      case "manage_photo":
        setPhotoTargetId(target.id);
        return;
      case "edit_assignment":
      case "manage_roles":
        setEditingId(target.id);
        return;
      case "individual_permission":
        setOverrideId(target.id);
        return;
      case "copy_details": {
        const row = (usersQuery.data ?? []).find(
          (r) => (r as unknown as { id: string }).id === target.id,
        ) as unknown as
          | {
              full_name: string | null;
              staff_id: string | null;
              email: string | null;
              job_title: string | null;
              branches: { name: string } | null;
              departments: { name: string } | null;
            }
          | undefined;
        const text = copyableAccountDetails({
          full_name: row?.full_name ?? null,
          staff_id: row?.staff_id ?? null,
          email: row?.email ?? null,
          job_title: row?.job_title ?? null,
          branch_name: row?.branches?.name ?? null,
          department_name: row?.departments?.name ?? null,
        });
        void navigator.clipboard
          .writeText(text)
          .then(() => toast.success("Account details copied"))
          .catch(() => toast.error("Could not copy to the clipboard"));
        return;
      }
      default:
        setPending({ action, target });
    }
  }

  async function runPendingAction(input: {
    reason: string;
    password: string;
    revokeAccess: boolean;
  }) {
    if (!pending) return;
    const { action, target } = pending;
    const reason = input.reason.trim();
    try {
      switch (action.id) {
        case "reset_password":
          if (input.password.trim().length < 8) {
            toast.error("The temporary password must be at least 8 characters.");
            return;
          }
          await resetPasswordFn({
            data: { user_id: target.id, password: input.password.trim() },
          });
          toast.success("Temporary password set. It must be changed at next sign-in.");
          break;
        case "require_password_change":
          await requirePasswordFn({ data: { user_id: target.id } });
          toast.success("Password change required at next sign-in");
          break;
        case "clear_password_requirement":
          await clearRequirementFn({ data: { user_id: target.id, reason } });
          toast.success("Password-change requirement cleared");
          break;
        case "resend_invitation":
          await resendInvitationFn({
            data: { user_id: target.id, redirect_to: `${window.location.origin}/auth` },
          });
          toast.success("Welcome / setup email re-issued");
          break;
        case "revoke_sessions":
          await revokeSessionsFn({ data: { user_id: target.id, reason } });
          toast.success("All active sessions revoked");
          break;
        case "reset_mfa":
          await resetMfaFn({ data: { user_id: target.id, reason } });
          toast.success("Two-factor enrolment cleared");
          break;
        case "suspend":
          await setStatusFn({ data: { user_id: target.id, status: "suspended" } });
          toast.success("Account suspended");
          break;
        case "deactivate":
          await setStatusFn({ data: { user_id: target.id, status: "inactive" } });
          toast.success("Account access deactivated");
          break;
        case "activate":
          await setStatusFn({ data: { user_id: target.id, status: "active" } });
          toast.success("Account reactivated");
          break;
        case "offboard":
          await offboardFn({
            data: {
              user_id: target.id,
              separation_type: "resignation",
              reason: reason || null,
              revoke_access: input.revokeAccess,
              last_working_day: null,
            },
          });
          toast.success("Employment ended through the HR offboarding workflow");
          break;
        case "delete_account":
          if (!reason) {
            toast.error("A reason is required.");
            return;
          }
          await deleteAccountFn({ data: { user_id: target.id, reason } });
          toast.success("Login account deleted. HR record and audit trail retained.");
          break;
        case "assign_owner":
          if (!reason) {
            toast.error("A reason is required.");
            return;
          }
          await assignOwnerFn({
            data: { user_id: target.id, reason, idempotency_key: `owner:${target.id}` },
          });
          toast.success("Owner role assigned");
          break;
        case "remove_owner":
          if (!reason) {
            toast.error("A reason is required.");
            return;
          }
          await removeOwnerFn({ data: { user_id: target.id, reason } });
          toast.success("Owner role removed");
          break;
        default:
          return;
      }
      setPending(null);
      refreshUsers();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Organization"
        title="Users"
        description="Every staff account, with branch, department, role and account status."
        actions={
          canCreate ? (
            <Button onClick={() => setOpen(true)}>
              <UserPlus className="size-4" /> Add user
            </Button>
          ) : null
        }
      />

      <SectionCard
        title="Staff directory"
        description={`${filtered.length} of ${(usersQuery.data ?? []).length} account(s)`}
        actions={
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, phone, staff ID"
              className="h-9 w-64 pl-9"
            />
          </div>
        }
      >
        <div className="mb-4 flex flex-wrap gap-2">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-9 w-full sm:w-44" aria-label="Filter by user type">
              <SelectValue placeholder="User type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All user types</SelectItem>
              {["permanent", "contract", "casual", "intern", "unspecified"].map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="h-9 w-full sm:w-44" aria-label="Filter by role">
              <SelectValue placeholder="Role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {(rolesQuery.data ?? []).map((r) => {
                const role = r as { id: string; name: string };
                return (
                  <SelectItem key={role.id} value={role.name}>
                    {role.name}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Select value={deptFilter} onValueChange={setDeptFilter}>
            <SelectTrigger className="h-9 w-full sm:w-48" aria-label="Filter by department">
              <SelectValue placeholder="Department" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              <SelectItem value="none">No department</SelectItem>
              {(deptQuery.data ?? []).map((d) => {
                const dept = d as { id: string; name: string };
                return (
                  <SelectItem key={dept.id} value={dept.id}>
                    {dept.name}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Select value={branchFilter} onValueChange={setBranchFilter}>
            <SelectTrigger className="h-9 w-full sm:w-48" aria-label="Filter by property">
              <SelectValue placeholder="Property" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All properties</SelectItem>
              <SelectItem value="org">Organization-wide</SelectItem>
              {(branchesQuery.data ?? []).map((b) => {
                const branch = b as { id: string; name: string };
                return (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-full sm:w-40" aria-label="Filter by status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {usersQuery.isError ? (
          <ErrorState error={usersQuery.error} title="Could not load staff accounts" />
        ) : usersQuery.isLoading ? (
          <LoadingState variant="table" rows={5} />
        ) : filtered.length === 0 ? (
          <EmptyState
            inline
            title={(usersQuery.data ?? []).length === 0 ? "No staff accounts yet" : "No staff match the current filters"}
            description={
              (usersQuery.data ?? []).length === 0
                ? "Add your first team member to get started."
                : "Adjust your filters to see more staff accounts."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Staff ID</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Last login</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((raw) => {
                  const u = raw as unknown as {
                    id: string;
                    full_name: string;
                    email: string;
                    phone: string;
                    staff_id: string;
                    job_title: string;
                    account_status: string;
                    last_login_at: string | null;
                    assignment_review_required: boolean | null;
                    assignment_review_reason: string | null;
                    reporting_manager_id: string | null;

                    branches: { name: string } | null;
                    departments: { name: string } | null;
                  };
                  const avatarPath =
                    (raw as unknown as { avatar_url?: string | null }).avatar_url ?? null;
                  return (
                    <TableRow key={u.id}>
                      <TableCell>
                        <span className="flex items-start gap-2">
                          <Avatar
                            path={avatarPath}
                            name={u.full_name || u.email}
                            size={32}
                            className="mt-0.5"
                          />
                          <span className="block">
                            <p className="font-medium">
                              {u.full_name || "Profile setup incomplete"}
                              {u.id === user?.id ? (
                                <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-[0.65rem] font-medium text-secondary-foreground">
                                  You
                                </span>
                              ) : null}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {[u.email, u.phone].filter(Boolean).join(" · ") ||
                                "No contact details"}
                            </p>
                            {u.job_title ? (
                              <p className="text-xs text-muted-foreground">{u.job_title}</p>
                            ) : null}
                            {/* A job title is never authorisation. Where the title
                            claims Owner but no canonical Owner role exists, the
                            mismatch is stated, never resolved automatically. */}
                            {u.job_title?.trim().toLowerCase() === "owner" &&
                            !(rolesByUser.get(u.id) ?? []).includes("Owner") ? (
                              <p className="mt-1 text-xs font-medium text-warning">
                                Assignment review required — job title Owner, canonical role missing
                                {u.staff_id ? "" : ", staff ID missing"}
                              </p>
                            ) : null}
                            {u.assignment_review_required ? (
                              <p className="mt-1 text-xs font-medium text-warning">
                                Assignment review required —{" "}
                                {u.assignment_review_reason || "confirm the reporting line"}
                              </p>
                            ) : null}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="text-sm">{u.staff_id || "—"}</TableCell>
                      <TableCell className="text-sm">{u.departments?.name ?? "—"}</TableCell>
                      <TableCell className="text-sm">{u.branches?.name ?? "—"}</TableCell>
                      <TableCell className="text-sm">
                        {(rolesByUser.get(u.id) ?? []).join(", ") || "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "Never"}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={statusTone(u.account_status)}>
                          {u.account_status}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-right">
                        {(() => {
                          const target = {
                            id: u.id,
                            email: u.email ?? null,
                            account_status: u.account_status ?? null,
                            employment_status:
                              (raw as unknown as { employment_status?: string | null })
                                .employment_status ?? null,
                            must_change_password:
                              (raw as unknown as { must_change_password?: boolean | null })
                                .must_change_password ?? null,
                            invitation_status:
                              (raw as unknown as { invitation_status?: string | null })
                                .invitation_status ?? null,
                            mfa_enrolled: null,
                            isSelf: u.id === user?.id,
                            isOwner: (rolesByUser.get(u.id) ?? []).includes("Owner"),
                          };
                          const groups = buildUserActionMenu(canFor, isAdmin, target);
                          if (groups.length === 0) {
                            return (
                              <span className="text-xs text-muted-foreground">No permission</span>
                            );
                          }
                          return (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8"
                                  aria-label={`Account administration for ${u.full_name || u.email}`}
                                >
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="end"
                                className="max-h-[70vh] w-72 overflow-y-auto"
                              >
                                {groups.map((group, index) => (
                                  <div key={group.group}>
                                    {index > 0 ? <DropdownMenuSeparator /> : null}
                                    <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                                    {group.actions.map((action) => (
                                      <DropdownMenuItem
                                        key={action.id}
                                        className={
                                          action.destructive ? "text-destructive" : undefined
                                        }
                                        onSelect={() => startAction(action, target)}
                                      >
                                        {action.label}
                                      </DropdownMenuItem>
                                    ))}
                                  </div>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          );
                        })()}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <AddUserDialog
        open={open}
        onOpenChange={setOpen}
        roles={rolesQuery.data ?? []}
        roleScopes={roleScopeQuery.data ?? []}
        branches={(branchesQuery.data ?? []) as { id: string; name: string }[]}
        departments={deptQuery.data ?? []}
        onCreate={async (payload) => {
          await createUserFn({ data: payload });
          void qc.invalidateQueries({ queryKey: ["profiles"] });
          void qc.invalidateQueries({ queryKey: ["user-roles"] });
        }}
      />

      <EditAssignmentDialog
        key={editingId ?? "none"}
        open={Boolean(editingId)}
        onOpenChange={(v) => setEditingId(v ? editingId : null)}
        roles={rolesQuery.data ?? []}
        roleScopes={roleScopeQuery.data ?? []}
        branches={(branchesQuery.data ?? []) as { id: string; name: string }[]}
        departments={deptQuery.data ?? []}
        stations={(stationsQuery.data ?? []) as { id: string; name: string }[]}

        initial={(() => {
          const row = (usersQuery.data ?? []).find(
            (r) => (r as unknown as { id: string }).id === editingId,
          ) as unknown as
            | {
                id: string;
                full_name: string;
                job_title: string | null;
                employment_status: string | null;
                branch_id: string | null;
                department_id: string | null;
              }
            | undefined;
          if (!row) return null;
          return {
            user_id: row.id,
            full_name: row.full_name,
            job_title: row.job_title ?? "",
            employment_status: row.employment_status || "full-time",
            branch_id: row.branch_id ?? "",
            department_id: row.department_id ?? "",
            station_id: stationByUser.get(row.id) ?? "",
            reporting_manager_profile_id: managerProfileByUser.get(row.id) ?? "",
            role_ids: roleIdsByUser.get(row.id) ?? [],
          };
        })()}
        onSave={async (payload) => {
          await updateAssignmentFn({ data: payload });
          void qc.invalidateQueries({ queryKey: ["profiles"] });
          void qc.invalidateQueries({ queryKey: ["user-roles"] });
          void qc.invalidateQueries({ queryKey: ["user-stations"] });
          void qc.invalidateQueries({ queryKey: ["reporting-candidates"] });

          void qc.invalidateQueries({ queryKey: ["preview-role-accounts"] });
          setEditingId(null);
        }}
      />

      <EffectiveAccessDialog userId={accessId} onClose={() => setAccessId(null)} />
      <AuditHistoryDialog userId={auditId} onClose={() => setAuditId(null)} />
      <PermissionOverrideDialog
        userId={overrideId}
        onClose={() => setOverrideId(null)}
        onApply={async (payload) => {
          await overrideFn({ data: payload });
          toast.success("Individual permission recorded");
          setOverrideId(null);
        }}
      />
      <ActionConfirmDialog
        pending={pending}
        onClose={() => setPending(null)}
        onConfirm={runPendingAction}
      />
      <AccessSecurityDialog
        target={securityTarget}
        onClose={() => setSecurityTarget(null)}
        onRunAction={(actionId) => {
          const action = USER_ACTIONS.find((a) => a.id === actionId);
          if (!action || !securityTarget) return;
          const target = securityTarget;
          setSecurityTarget(null);
          startAction(action, target);
        }}
      />
      <StaffPhotoDialog
        userId={photoTargetId}
        currentPath={
          (
            (usersQuery.data ?? []).find(
              (r) => (r as unknown as { id: string }).id === photoTargetId,
            ) as unknown as { avatar_url?: string | null } | undefined
          )?.avatar_url ?? null
        }
        onClose={() => setPhotoTargetId(null)}
        onSaved={refreshUsers}
      />
    </div>
  );
}

/**
 * Consequential account actions pass through here first: the impact is stated,
 * a reason is collected where the action carries one, and a temporary password
 * is entered rather than revealed — the stored password is never readable.
 */
function ActionConfirmDialog({
  pending,
  onClose,
  onConfirm,
}: {
  pending: { action: UserAction; target: UserActionTarget } | null;
  onClose: () => void;
  onConfirm: (input: { reason: string; password: string; revokeAccess: boolean }) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [revokeAccess, setRevokeAccess] = useState(true);
  const [busy, setBusy] = useState(false);
  const action = pending?.action ?? null;
  const isPasswordReset = action?.id === "reset_password";
  const isOffboard = action?.id === "offboard";

  /**
   * Security actions read the live enrolment state so a two-factor reset is
   * never offered against an account that has nothing enrolled. Only counts are
   * read — no secret, device identifier or recovery code.
   */
  const fetchMeta = useServerFn(getStaffSecurityMetadata);
  const securityState = useQuery({
    queryKey: ["staff-security-metadata", pending?.target.id, action?.id],
    enabled: Boolean(pending && action?.group === "security"),
    queryFn: async () => await fetchMeta({ data: { user_id: pending!.target.id } }),
  });

  const mfaState: MfaState = pending
    ? securityState.data
      ? mfaStateFromFactors(securityState.data.mfa_factors)
      : action?.group === "security"
        ? "unknown"
        : mfaStateFromFactors(
            pending.target.mfa_enrolled === null ? null : pending.target.mfa_enrolled ? 1 : 0,
          )
    : "unknown";

  const impact = pending
    ? accountActionImpact(pending.action.id, {
        target: pending.target,
        mfaState,
        revokeAccess,
      })
    : null;
  const blocked =
    action?.id === "reset_mfa" && mfaState === "not_enrolled" ? impact?.blocked : impact?.blocked;

  return (
    <Dialog
      open={Boolean(pending)}
      onOpenChange={(v) => {
        if (!v) {
          setReason("");
          setPassword("");
          setRevokeAccess(true);
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{action?.label.replace(/…$/, "") ?? "Confirm"}</DialogTitle>
          <DialogDescription>
            {impact?.headline ?? "This change is recorded in the audit trail."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {impact ? (
            <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  What will change
                </p>
                <ul className="list-disc space-y-1 pl-4">
                  {impact.changes.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              {impact.unchanged.length ? (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    What stays the same
                  </p>
                  <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                    {impact.unchanged.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={impact.reversible ? "info" : "warning"}>
                  {impact.reversible ? "Reversible" : "Cannot be undone"}
                </StatusPill>
                {action?.group === "security" && securityState.isLoading ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" /> Reading account state…
                  </span>
                ) : null}
                {action?.id === "reset_mfa" && mfaState !== "unknown" ? (
                  <StatusPill tone={mfaState === "enrolled" ? "success" : "warning"}>
                    {mfaWorkflow(mfaState, securityState.data?.mfa_factors ?? null).label}
                  </StatusPill>
                ) : null}
              </div>
              {blocked ? (
                <p className="flex items-start gap-2 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {blocked}
                </p>
              ) : null}
            </div>
          ) : null}
          {isPasswordReset ? (
            <div className="space-y-1.5">
              <Label htmlFor="temp-password">Temporary password (min 8 characters)</Label>
              <Input
                id="temp-password"
                type="text"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Issued to the person directly"
              />
              <p className="text-xs text-muted-foreground">
                A password change is required at their next sign-in.
              </p>
            </div>
          ) : null}
          {isOffboard ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={revokeAccess}
                onCheckedChange={(v) => setRevokeAccess(v === true)}
              />
              Close system access as part of the offboarding
            </label>
          ) : null}
          {action?.requiresReason || isOffboard ? (
            <div className="space-y-1.5">
              <Label htmlFor="action-reason">
                Reason{action?.requiresReason ? "" : " (optional)"}
              </Label>
              <Input
                id="action-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Stored on the audit record"
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={action?.destructive ? "destructive" : "default"}
            disabled={
              busy ||
              Boolean(blocked) ||
              (Boolean(action?.requiresReason) && !reason.trim()) ||
              (isPasswordReset && password.trim().length < 8)
            }
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm({ reason, password, revokeAccess });
                setReason("");
                setPassword("");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null} Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Guided Access & security workflow.
 *
 * The panel reads the account's real state first, then offers only the steps
 * that state allows: a two-factor reset appears where there is an enrolment to
 * clear, and the password requirement step matches whether one is outstanding.
 * Nothing sensitive is fetched — enrolment counts and timestamps only, never a
 * password, hash, device secret or recovery code.
 */
function AccessSecurityDialog({
  target,
  onClose,
  onRunAction,
}: {
  target: UserActionTarget | null;
  onClose: () => void;
  onRunAction: (actionId: string) => void;
}) {
  const fetchMeta = useServerFn(getStaffSecurityMetadata);
  const query = useQuery({
    queryKey: ["staff-security-metadata", target?.id],
    enabled: Boolean(target),
    queryFn: async () => await fetchMeta({ data: { user_id: target!.id } }),
  });

  const mfaState: MfaState = query.data ? mfaStateFromFactors(query.data.mfa_factors) : "unknown";
  const mfa = mfaWorkflow(mfaState, query.data?.mfa_factors ?? null);
  const password = passwordWorkflow({
    must_change_password: query.data
      ? query.data.must_change_password
      : (target?.must_change_password ?? null),
  });

  const rows: Array<[string, string]> = query.data
    ? [
        ["Email", query.data.email ?? "—"],
        ["Account status", query.data.account_status ?? "—"],
        [
          "Last sign-in",
          query.data.last_sign_in_at
            ? new Date(query.data.last_sign_in_at).toLocaleString()
            : "Never",
        ],
        [
          "Email confirmed",
          query.data.email_confirmed_at
            ? new Date(query.data.email_confirmed_at).toLocaleString()
            : "Not confirmed",
        ],
        [
          "Two-factor devices",
          `${query.data.mfa_factors} (${query.data.mfa_verified_factors} verified)`,
        ],
        ["Sign-in methods", query.data.providers.join(", ") || "—"],
        [
          "Account created",
          query.data.created_at ? new Date(query.data.created_at).toLocaleString() : "—",
        ],
      ]
    : [];

  return (
    <Dialog open={Boolean(target)} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Access &amp; security</DialogTitle>
          <DialogDescription>
            Current sign-in state and the security steps available for it. Passwords, hashes, device
            secrets and recovery codes are never readable here.
          </DialogDescription>
        </DialogHeader>
        {query.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading account state…
          </div>
        ) : query.error ? (
          <ErrorState error={query.error} inline />
        ) : (
          <div className="space-y-5">
            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={mfaState === "enrolled" ? "success" : "warning"}>
                  {mfa.label}
                </StatusPill>
                <span className="text-xs text-muted-foreground">{mfa.detail}</span>
              </div>
              <p className="text-sm text-muted-foreground">{mfa.guidance}</p>
              <Button
                size="sm"
                variant="destructive"
                disabled={!mfa.canReset}
                onClick={() => onRunAction("reset_mfa")}
              >
                Reset two-factor enrolment
              </Button>
              {!mfa.canReset && mfa.blockedReason ? (
                <p className="text-xs text-muted-foreground">{mfa.blockedReason}</p>
              ) : null}
            </div>

            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={password.requirementOutstanding ? "warning" : "info"}>
                  {password.label}
                </StatusPill>
              </div>
              <p className="text-sm text-muted-foreground">{password.guidance}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => onRunAction("reset_password")}>
                  Reset password…
                </Button>
                {password.requirementOutstanding ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onRunAction("clear_password_requirement")}
                  >
                    Clear requirement
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onRunAction("require_password_change")}
                  >
                    Require change at next sign-in
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => onRunAction("revoke_sessions")}>
                  Force sign-out
                </Button>
              </div>
            </div>

            <dl className="divide-y text-sm">
              {rows.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 py-2">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-right font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Official staff photograph. The image itself stays HR-owned: this dialog is
 * only reachable with the `human-resources.staff-photos.manage` capability,
 * held by HR, Owner/Director and IT/System Administration.
 */
function StaffPhotoDialog({
  userId,
  currentPath,
  onClose,
  onSaved,
}: {
  userId: string | null;
  currentPath: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const setPhoto = useSetStaffPhoto();
  return (
    <Dialog open={Boolean(userId)} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Official staff photo</DialogTitle>
          <DialogDescription>
            HR owns this image. It appears on every surface that shows the person; ordinary staff
            cannot replace it themselves.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-4">
          <Avatar path={currentPath} name="Staff photo" size={64} />
          <Input
            type="file"
            accept="image/*"
            onChange={async (e) => {
              const file = e.target.files?.[0] ?? null;
              if (!file || !userId) return;
              await setPhoto.mutateAsync({
                target: { profileId: userId, currentPath },
                file,
              });
              onSaved();
              onClose();
            }}
          />
        </div>
        <DialogFooter>
          {currentPath ? (
            <Button
              variant="outline"
              onClick={async () => {
                if (!userId) return;
                await setPhoto.mutateAsync({
                  target: { profileId: userId, currentPath },
                  file: null,
                });
                onSaved();
                onClose();
              }}
            >
              Remove photo
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Read-only preview of a colleague's assignments and effective capabilities. */
function EffectiveAccessDialog({
  userId,
  onClose,
}: {
  userId: string | null;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["simulate-access", userId],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_simulate_access", { _user: userId! });
      if (error) throw error;
      return data as unknown as {
        full_name: string;
        account_status: string;
        account_type: string;
        primary_branch_id: string | null;
        department_id: string | null;
        roles: { name: string; scope: string | null; is_primary: boolean | null }[];
        capabilities: string[];
      };
    },
  });

  return (
    <Dialog open={Boolean(userId)} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Profile and effective access</DialogTitle>
          <DialogDescription>
            Exactly what this account can reach today — assignments, roles and granted capabilities.
          </DialogDescription>
        </DialogHeader>
        {query.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Resolving access…
          </div>
        ) : query.isError ? (
          <ErrorState className="my-2" error={query.error} inline />
        ) : query.data ? (
          <div className="space-y-4 text-sm">
            <div>
              <p className="font-medium">{query.data.full_name || "Profile setup incomplete"}</p>
              <p className="text-muted-foreground">
                {query.data.account_type} · {query.data.account_status}
              </p>
            </div>
            <div>
              <p className="mb-1 font-medium">Roles</p>
              {query.data.roles.length ? (
                <ul className="space-y-1 text-muted-foreground">
                  {query.data.roles.map((r) => (
                    <li key={r.name}>
                      {r.name}
                      {r.is_primary ? " · primary" : ""}
                      {r.scope ? ` · ${r.scope} scope` : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No role assigned — setup incomplete.</p>
              )}
            </div>
            <div>
              <p className="mb-1 font-medium">Capabilities ({query.data.capabilities.length})</p>
              <div className="max-h-64 overflow-y-auto rounded-md border p-3 text-xs text-muted-foreground">
                {query.data.capabilities.length
                  ? [...query.data.capabilities].sort().map((c) => <p key={c}>{c}</p>)
                  : "No capabilities granted."}
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Attributable audit & history panel for one staff account.
 *
 * Each entry answers who, what, when and why, and expands into the field-level
 * before/after state. Payloads are redacted on the way in, so a credential can
 * never be read out of the audit trail.
 */
function AuditHistoryDialog({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const [category, setCategory] = useState<AuditCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const query = useQuery({
    queryKey: ["user-audit", userId, filterKey],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase
          .from("audit_logs")
          .select("id, created_at, action, module, user_name, reason, previous_value, new_value"),
        "audit_logs",
      )
        .eq("record_id", userId!)
        .gte("created_at", from ? new Date(from).toISOString() : auditWindowFrom())
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as AuditRow[];
    },
  });

  const rows = useMemo(
    () =>
      filterAuditRows(query.data ?? [], { category, search, from: from || null, to: to || null }),
    [query.data, category, search, from, to],
  );

  return (
    <Dialog open={Boolean(userId)} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Audit &amp; history</DialogTitle>
          <DialogDescription>
            Every recorded administrative change to this account — who made it, when, why, and the
            state before and after. Credential material is never stored or shown.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Select value={category} onValueChange={(v) => setCategory(v as AuditCategory | "all")}>
            <SelectTrigger aria-label="Audit category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {AUDIT_CATEGORY_ORDER.map((c) => (
                <SelectItem key={c} value={c}>
                  {AUDIT_CATEGORY_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Search audit history"
            placeholder="Search action, actor or reason"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <NeoDateRangePicker
            from={from}
            to={to}
            quick={["today", "this-week", "this-month"]}
            onChange={({ from: f, to: t }) => {
              setFrom(f);
              setTo(t);
            }}
          />
        </div>
        {query.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading history…
          </div>
        ) : query.isError ? (
          <ErrorState className="my-2" error={query.error} inline />
        ) : rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            {(query.data ?? []).length === 0
              ? "No recorded activity yet."
              : "No entries match these filters."}
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {rows.map((row) => {
              const changes = auditFieldDiff(row.previous_value, row.new_value);
              return (
                <li key={row.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{auditActionLabel(row.action)}</p>
                    <StatusPill>
                      {AUDIT_CATEGORY_LABELS[classifyAuditAction(row.action)]}
                    </StatusPill>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {new Date(row.created_at).toLocaleString()}
                    {row.module ? ` · ${row.module}` : ""}
                    {row.user_name ? ` · by ${row.user_name}` : " · actor not recorded"}
                  </p>
                  {row.reason ? (
                    <p className="mt-1 text-xs text-muted-foreground">Reason: {row.reason}</p>
                  ) : null}
                  {changes.length ? (
                    <table className="mt-2 w-full text-xs">
                      <thead>
                        <tr className="text-left text-muted-foreground">
                          <th className="py-1 pr-2 font-medium">Field</th>
                          <th className="py-1 pr-2 font-medium">Before</th>
                          <th className="py-1 font-medium">After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {changes.map((c) => (
                          <tr key={c.field} className="border-t border-border/60">
                            <td className="py-1 pr-2">{c.field.replace(/_/g, " ")}</td>
                            <td className="py-1 pr-2 text-muted-foreground">{c.before}</td>
                            <td className="py-1 font-medium">{c.after}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      No field-level state was recorded for this entry.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Individual grant or denial of a single catalogue capability, with expiry. */
function PermissionOverrideDialog({
  userId,
  onClose,
  onApply,
}: {
  userId: string | null;
  onClose: () => void;
  onApply: (payload: {
    user_id: string;
    module: string;
    feature: string;
    action: string;
    effect: "grant" | "deny" | "clear";
    valid_until?: string | null;
    reason?: string | null;
  }) => Promise<void>;
}) {
  const [permissionId, setPermissionId] = useState("");
  const [effect, setEffect] = useState<"grant" | "deny" | "clear">("grant");
  const [validUntil, setValidUntil] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const catalogue = useQuery({
    queryKey: ["permission-catalogue"],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("permissions")
        .select("id, module, feature, action")
        .order("module")
        .order("feature")
        .order("action");
      if (error) throw error;
      return (data ?? []) as { id: string; module: string; feature: string; action: string }[];
    },
  });

  const existing = useQuery({
    queryKey: ["user-permissions", userId],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_permissions")
        .select("id, effect, valid_until, permissions(module, feature, action)")
        .eq("user_id", userId!);
      if (error) throw error;
      return data ?? [];
    },
  });

  const selected = (catalogue.data ?? []).find((p) => p.id === permissionId);

  return (
    <Dialog open={Boolean(userId)} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Individual permission</DialogTitle>
          <DialogDescription>
            Grant or deny a single capability for this account, optionally until a date.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Capability</Label>
            <Select value={permissionId} onValueChange={setPermissionId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a capability" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {(catalogue.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.module}.{p.feature}.{p.action}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Effect</Label>
            <Select value={effect} onValueChange={(v) => setEffect(v as typeof effect)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="grant">Grant</SelectItem>
                <SelectItem value="deny">Deny</SelectItem>
                <SelectItem value="clear">Remove existing override</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="valid-until">Expires (optional)</Label>
            <NeoDatePicker id="valid-until" value={validUntil} onChange={setValidUntil} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="override-reason">Reason</Label>
            <Input
              id="override-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why this individual permission is needed"
            />
          </div>
          {(existing.data ?? []).length ? (
            <div className="rounded-md border p-3 text-xs text-muted-foreground">
              <p className="mb-1 font-medium text-foreground">Existing overrides</p>
              {(existing.data ?? []).map((raw) => {
                const row = raw as unknown as {
                  id: string;
                  effect: string;
                  valid_until: string | null;
                  permissions: { module: string; feature: string; action: string } | null;
                };
                return (
                  <p key={row.id}>
                    {row.effect}: {row.permissions?.module}.{row.permissions?.feature}.
                    {row.permissions?.action}
                    {row.valid_until
                      ? ` · until ${new Date(row.valid_until).toLocaleDateString()}`
                      : ""}
                  </p>
                );
              })}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!selected || busy}
            onClick={async () => {
              if (!selected || !userId) return;
              setBusy(true);
              try {
                await onApply({
                  user_id: userId,
                  module: selected.module,
                  feature: selected.feature,
                  action: selected.action,
                  effect,
                  valid_until: validUntil ? new Date(validUntil).toISOString() : null,
                  reason: reason || null,
                });
              } catch (err) {
                toast.error((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null} Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddUserDialog({
  open,
  onOpenChange,
  roles,
  roleScopes,
  branches,
  departments,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  roles: ScopedRole[];
  roleScopes: CatalogueScope[];
  branches: { id: string; name: string }[];
  departments: ScopedDepartment[];
  onCreate: (payload: {
    email: string;
    password: string;
    full_name: string;
    staff_id: string;
    phone: string;
    job_title: string;
    branch_id: string | null;
    department_id: string | null;
    employment_status: string;
    role_ids: string[];
    reporting_manager_profile_id: string | null;
  }) => Promise<void>;

}) {
  const [form, setForm] = useState({
    email: "",
    password: "",
    full_name: "",
    staff_id: "",
    phone: "",
    job_title: "",
    branch_id: "",
    department_id: "",
    employment_status: "full-time",
  });
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [managerId, setManagerId] = useState("");
  const [busy, setBusy] = useState(false);

  // Departments belong to a property: only the selected property's departments
  // (plus organisation-wide ones) may be chosen.
  const visibleDepartments = useMemo(
    () => departmentsForBranch(departments, form.branch_id || null),
    [departments, form.branch_id],
  );
  // Roles are offered by canonical department relationship, never by name.
  const visibleRoles = useMemo(
    () => rolesForDepartment(roles, departments, form.department_id || null, roleScopes),
    [roles, departments, form.department_id, roleScopes],
  );

  /**
   * Eligible managers for the roles, department and property chosen so far.
   * The database walks the canonical hierarchy — and, when the named superior
   * role is genuinely unstaffed, the next valid superior above it — so the
   * list never depends on job-title text or hard-coded names.
   */
  const candidatesQuery = useQuery({
    queryKey: [
      "reporting-candidates",
      "new-user",
      form.branch_id,
      form.department_id,
      [...roleIds].sort().join(","),
    ],
    enabled: open && roleIds.length > 0,
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_reporting_candidates" as never, {
        _user: null,
        _branch: form.branch_id || null,
        _department: form.department_id || null,
        _station: null,
        _role_ids: roleIds,
      } as never);
      if (error) throw error;
      return (data ?? []) as unknown as {
        profile_id: string;
        full_name: string;
        staff_id: string | null;
        role_name: string | null;
        property_match: string;
      }[];
    },
  });
  const managers = candidatesQuery.data ?? [];

  // A property, department or role change re-resolves the line: a manager the
  // new assignment no longer permits is dropped rather than silently saved.
  useEffect(() => {
    if (!managerId) return;
    if (candidatesQuery.isLoading) return;
    if (!managers.some((m) => m.profile_id === managerId)) setManagerId("");
  }, [managers, managerId, candidatesQuery.isLoading]);

  const set = (k: keyof typeof form, v: string) =>
    setForm((p) => {
      const next = { ...p, [k]: v };
      if (
        k === "branch_id" &&
        !isDepartmentValidForBranch(departments, v || null, p.department_id)
      ) {
        next.department_id = "";
      }
      if (next.department_id !== p.department_id) {
        setRoleIds((ids) =>
          pruneRoleIds(ids, roles, departments, next.department_id || null, roleScopes),
        );
      }
      return next;
    });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const payload = normaliseStaffAccountInput({
      ...form,
      branch_id: form.branch_id || null,
      department_id: form.department_id || null,
      role_ids: roleIds,
    });
    const problem = validateStaffAccountInput(payload);
    if (problem) {
      toast.error(problem);
      return;
    }
    setBusy(true);
    try {
      await onCreate({ ...payload, reporting_manager_profile_id: managerId || null });
      toast.success("Staff account created");
      onOpenChange(false);
      setForm({
        email: "",
        password: "",
        full_name: "",
        staff_id: "",
        phone: "",
        job_title: "",
        branch_id: "",
        department_id: "",
        employment_status: "full-time",
      });
      setRoleIds([]);
      setManagerId("");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add staff user</DialogTitle>
          <DialogDescription>
            The account is created immediately and the user must change the temporary password at
            first sign-in.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="full_name">Full name</Label>
            <Input
              id="full_name"
              required
              value={form.full_name}
              onChange={(e) => set("full_name", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="staff_id">Staff ID</Label>
            <Input
              id="staff_id"
              value="System generated"
              readOnly
              disabled
              aria-readonly="true"
              className="font-mono text-muted-foreground"
            />
            <p className="text-xs text-muted-foreground">
              Issued automatically when the account is created. It cannot be typed or edited.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              required
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Mobile number</Label>
            <Input id="phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Recorded once here. From then on the official number is maintained on the HR employee
              record.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Temporary password</Label>
            <Input
              id="password"
              type="text"
              minLength={8}
              required
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="job_title">Job title</Label>
            <Input
              id="job_title"
              value={form.job_title}
              onChange={(e) => set("job_title", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Branch</Label>
            <Select value={form.branch_id} onValueChange={(v) => set("branch_id", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Department</Label>
            <Select value={form.department_id} onValueChange={(v) => set("department_id", v)}>
              <SelectTrigger>
                <SelectValue
                  placeholder={form.branch_id ? "Select department" : "Select a property first"}
                />
              </SelectTrigger>
              <SelectContent>
                {visibleDepartments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                    {d.branch_id === null ? " (organisation-wide)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.branch_id && visibleDepartments.length === 0 ? (
              <p className="text-xs text-warning">This property has no departments yet.</p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label>Employment status</Label>
            <Select
              value={form.employment_status}
              onValueChange={(v) => set("employment_status", v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full-time">Full time</SelectItem>
                <SelectItem value="part-time">Part time</SelectItem>
                <SelectItem value="casual">Casual</SelectItem>
                <SelectItem value="contract">Contract</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="sm:col-span-2">
            <Label className="mb-2 block">Roles</Label>
            <div className="grid max-h-44 grid-cols-2 gap-2 overflow-y-auto rounded-lg border border-border p-3">
              {visibleRoles.length === 0 ? (
                <p className="col-span-2 text-xs text-muted-foreground">
                  {form.department_id
                    ? "No assignable role belongs to this department yet."
                    : "Select a department to see the roles that belong to it."}
                </p>
              ) : (
                visibleRoles.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={roleIds.includes(r.id)}
                      onCheckedChange={(v) =>
                        setRoleIds((prev) =>
                          v ? [...prev, r.id] : prev.filter((id) => id !== r.id),
                        )
                      }
                    />
                    {r.name}
                  </label>
                ))
              )}
            </div>
            {form.department_id ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Only roles that belong to the selected department are offered, plus genuinely
                organisation-wide roles.
              </p>
            ) : null}
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label>Reports to</Label>
            <Select
              value={managerId || "none"}
              onValueChange={(v) => setManagerId(v === "none" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="No reporting manager" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No reporting manager</SelectItem>
                {managers.map((m) => (
                  <SelectItem key={m.profile_id} value={m.profile_id}>
                    {m.full_name}
                    {m.staff_id ? ` · ${m.staff_id}` : ""}
                    {m.role_name ? ` — ${m.role_name}` : ""}
                    {m.property_match === "wider" ? " (organisation-wide)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {roleIds.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Select the roles first — eligible managers come from the canonical role hierarchy.
              </p>
            ) : candidatesQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Resolving eligible managers…</p>
            ) : managers.length === 0 ? (
              <p className="text-xs text-warning">
                No active manager holds a role that may manage this assignment. The account is
                created and flagged as reporting line incomplete.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                This is the organisational reporting line only. It grants no permissions and does
                not decide approval routing.
              </p>
            )}
          </div>



          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type AssignmentForm = {
  user_id: string;
  full_name: string;
  job_title: string;
  employment_status: string;
  branch_id: string;
  department_id: string;
  station_id: string;
  reporting_manager_profile_id: string;
  role_ids: string[];
};

/**
 * Editing an existing employee's assignment. Roles, property, department,
 * station and the reporting line are saved together through one authorised
 * server function, so what User Management shows, what Role Testing simulates
 * and what the employee actually receives at login all resolve from the same
 * records.
 */
function EditAssignmentDialog({
  open,
  onOpenChange,
  roles,
  roleScopes,
  branches,
  departments,
  stations,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  roles: ScopedRole[];
  roleScopes: CatalogueScope[];
  branches: { id: string; name: string }[];
  departments: ScopedDepartment[];
  stations: { id: string; name: string }[];
  initial: AssignmentForm | null;
  onSave: (payload: {
    user_id: string;
    job_title: string;
    employment_status: string;
    branch_id: string | null;
    department_id: string | null;
    station_id: string | null;
    reporting_manager_profile_id: string | null;
    role_ids: string[];
  }) => Promise<void>;
}) {
  const [form, setForm] = useState<AssignmentForm | null>(initial);
  const [busy, setBusy] = useState(false);
  const current = form ?? initial;

  const visibleDepartments = useMemo(
    () => departmentsForBranch(departments, current?.branch_id || null),
    [departments, current?.branch_id],
  );
  const visibleRoles = useMemo(
    () => rolesForDepartment(roles, departments, current?.department_id || null, roleScopes),
    [roles, departments, current?.department_id, roleScopes],
  );

  /**
   * Only stations that already exist at the selected property and department
   * may be assigned — a role never creates a station, and an administrator can
   * never attach an employee to another property's station.
   */
  const scopedStations = useScopedStations(
    current?.department_id || null,
    current?.branch_id || null,
  );
  const stationOptions = (scopedStations.data ?? []).length
    ? (scopedStations.data ?? []).map((s) => ({ id: s.id, name: s.name }))
    : stations;

  /**
   * The permanent assignment chain, recomputed live from the form, so the
   * administrator sees exactly what still blocks the account from becoming
   * operationally active — and the same resolver decides it at sign-in.
   */
  const chain = resolveAssignmentChain({
    organizationId: "assigned",
    branchIds: current?.branch_id ? [current.branch_id] : [],
    departmentIds: current?.department_id ? [current.department_id] : [],
    stationIds: current?.station_id ? [current.station_id] : [],
    roleNames: (current?.role_ids ?? [])
      .map((id) => roles.find((r) => r.id === id))
      .map((r) => r?.normalized_role_key || r?.name || "")
      .filter(Boolean),
    reportingManagerId: current?.reporting_manager_profile_id || null,
  });

  /**
   * Eligible managers come from the canonical role catalogue, keyed on the
   * roles, department and property currently selected — so the list changes
   * the moment the assignment changes, and never lists a name that the
   * reporting rules would refuse.
   */
  const candidatesQuery = useQuery({
    queryKey: [
      "reporting-candidates",
      current?.user_id,
      current?.branch_id,
      current?.department_id,
      current?.station_id,
      [...(current?.role_ids ?? [])].sort().join(","),
    ],
    enabled: Boolean(open && current),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, 
        "neo_reporting_candidates" as never,
        {
          _user: current!.user_id,
          _branch: current!.branch_id || null,
          _department: current!.department_id || null,
          _station: current!.station_id || null,
          _role_ids: current!.role_ids,
        } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as {
        profile_id: string;
        full_name: string;
        staff_id: string | null;
        role_name: string | null;
        property_match: string;
      }[];
    },
  });
  const managers = candidatesQuery.data ?? [];

  // Property, department or role changes re-resolve the line. A manager the
  // new assignment no longer permits is cleared so a replacement is chosen
  // rather than an ineligible line being saved.
  const selectedManagerId = current?.reporting_manager_profile_id || "";
  const managersLoading = candidatesQuery.isLoading;
  const managerStillEligible = managers.some((m) => m.profile_id === selectedManagerId);
  useEffect(() => {
    if (!selectedManagerId || managersLoading || managerStillEligible) return;
    setForm((prev) => (prev ? { ...prev, reporting_manager_profile_id: "" } : prev));
  }, [selectedManagerId, managersLoading, managerStillEligible]);

  if (!current) return null;


  /**
   * A property change drops a department that belongs to another property, and
   * any department change drops role selections the new department no longer
   * permits — the interface never carries a stale grant into a save.
   */
  const set = (patch: Partial<AssignmentForm>) => {
    const next: AssignmentForm = { ...current, ...patch };
    if (!isDepartmentValidForBranch(departments, next.branch_id || null, next.department_id)) {
      next.department_id = "";
    }
    if (next.department_id !== current.department_id) {
      next.role_ids = pruneRoleIds(
        next.role_ids,
        roles,
        departments,
        next.department_id || null,
        roleScopes,
      );
    }
    setForm(next);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!current) return;
    const roleKeyNames = current.role_ids
      .map((id) => roles.find((r) => r.id === id))
      .map((r) => r?.normalized_role_key || r?.name || "")
      .filter(Boolean);
    if (requiresStation(roleKeyNames) && !current.station_id) {
      toast.error(
        "This role only works station tickets. Assign an existing station of the selected property first.",
      );
      return;
    }
    if (current.station_id && !stationOptions.some((s) => s.id === current.station_id)) {
      toast.error("The selected station does not belong to the selected property and department.");
      return;
    }
    setBusy(true);
    try {
      await onSave({
        user_id: current.user_id,
        job_title: current.job_title,
        employment_status: current.employment_status,
        branch_id: current.branch_id || null,
        department_id: current.department_id || null,
        station_id: current.station_id || null,
        reporting_manager_profile_id: current.reporting_manager_profile_id || null,
        role_ids: current.role_ids,
      });
      toast.success("Assignment updated. The employee's access refreshes within a minute.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit assignment</DialogTitle>
          <DialogDescription>
            {current.full_name || "This account"} — property, department, station and roles.
            Removing a role removes the access it granted.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="edit_job_title">Job title</Label>
            <Input
              id="edit_job_title"
              value={current.job_title}
              onChange={(e) => set({ job_title: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>Employment status</Label>
            <Select
              value={current.employment_status}
              onValueChange={(v) => set({ employment_status: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full-time">Full time</SelectItem>
                <SelectItem value="part-time">Part time</SelectItem>
                <SelectItem value="casual">Casual</SelectItem>
                <SelectItem value="contract">Contract</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Property</Label>
            <Select
              value={current.branch_id || "none"}
              onValueChange={(v) => set({ branch_id: v === "none" ? "" : v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Organization-wide" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Organization-wide</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Department</Label>
            <Select
              value={current.department_id || "none"}
              onValueChange={(v) => set({ department_id: v === "none" ? "" : v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unassigned</SelectItem>
                {visibleDepartments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                    {d.branch_id === null ? " (organisation-wide)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label>Station</Label>
            <Select
              value={current.station_id || "none"}
              onValueChange={(v) => set({ station_id: v === "none" ? "" : v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="No station" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No station</SelectItem>
                {stationOptions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Reports to</Label>
            <Select
              value={current.reporting_manager_profile_id || "none"}
              onValueChange={(v) => set({ reporting_manager_profile_id: v === "none" ? "" : v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="No reporting manager" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No reporting manager</SelectItem>
                {managers
                  .filter((m) => m.profile_id !== current.user_id)
                  .map((m) => (
                    <SelectItem key={m.profile_id} value={m.profile_id}>
                      {m.full_name}
                      {m.staff_id ? ` · ${m.staff_id}` : ""}
                      {m.role_name ? ` — ${m.role_name}` : ""}
                      {m.property_match === "wider" ? " (organisation-wide)" : ""}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {candidatesQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Resolving eligible managers…</p>
            ) : managers.length === 0 ? (
              <p className="text-xs text-warning">
                No active manager holds a role that may manage this assignment. Save without a
                reporting line — the account is flagged as assignment review required.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Eligible managers come from the role catalogue, not job titles. Self-reporting,
                circular chains, inactive accounts and managers from another organisation are
                refused.
              </p>
            )}
          </div>

          <div className="space-y-2 sm:col-span-2 rounded-lg border border-border p-3">
            <p className="text-sm font-medium text-foreground">Assignment chain</p>
            <p className="text-xs text-muted-foreground">
              Organisation → Property → Department → Role → Station/Section → Reporting manager →
              Record scope. The account only becomes operationally active once every required
              step is complete.
            </p>
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {chain.steps.map((s) => (
                <li key={s.key} className="text-xs">
                  <span
                    className={
                      s.status === "complete"
                        ? "font-medium text-success"
                        : s.status === "missing"
                          ? "font-medium text-destructive"
                          : "font-medium text-muted-foreground"
                    }
                  >
                    {s.label}
                  </span>{" "}
                  <span className="text-muted-foreground">— {s.detail}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Record scope:{" "}
              <span className="text-foreground">
                {chain.recordScope
                  ? RECORD_SCOPE_LABELS[chain.recordScope]
                  : "Not resolved — no recognised role"}
              </span>
            </p>
            {chain.operationallyActive ? null : (
              <p className="text-xs text-warning">
                Outstanding: {chain.missing.map((m) => m.label).join(", ")}. The assignment can be
                saved, but the employee stays inactive until these are completed.
              </p>
            )}
          </div>

          <div className="sm:col-span-2">
            <Label className="mb-2 block">Roles</Label>
            <div className="grid max-h-44 grid-cols-2 gap-2 overflow-y-auto rounded-lg border border-border p-3">
              {visibleRoles.length === 0 ? (
                <p className="col-span-2 text-xs text-muted-foreground">
                  Select a department to see the roles that belong to it.
                </p>
              ) : (
                visibleRoles.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={current.role_ids.includes(r.id)}
                      onCheckedChange={(v) =>
                        set({
                          role_ids: v
                            ? [...current.role_ids, r.id]
                            : current.role_ids.filter((id) => id !== r.id),
                        })
                      }
                    />
                    {r.name}
                  </label>
                ))
              )}
            </div>
            {current.role_ids.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                With no role assigned this account can sign in but reaches no module.
              </p>
            ) : null}
          </div>

          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Save assignment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/users">
      <UsersPage />
    </OpsGuard>
  );
}
