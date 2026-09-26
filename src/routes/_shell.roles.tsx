import { guardedRpc } from "@/lib/rpc-guard";
import { Fragment, useMemo, useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useScopedDepartments } from "@/lib/scoped-options";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { PERMISSION_ACTIONS, actionLabels, moduleLabels } from "@/lib/permissions";
import { moduleFeatures } from "@/lib/capabilities";
import { interpretApplyResult, parseTemplateStatus } from "@/lib/role-template-apply";
import { resolveCatalogueRoleKey } from "@/lib/role-aliases";
import { DeleteStructureRecord } from "@/components/common/DeleteStructureRecord";

import {
  describePermissionDiff,
  diffPermissionSets,
  groupPermissionsByModule,
  isEmptyDiff,
  permissionLabel,
  type PermissionRef,
} from "@/lib/permission-diff";
import {
  accessScopeLabels,
  multiplicityLabels,
  restrictedReasons,
  useRestrictedActions,
  useRoleCatalogue,
} from "@/lib/role-catalogue";

export const Route = createFileRoute("/_shell/roles")({
  head: () => ({
    meta: [
      { title: "Roles & permissions — NEØ" },
      {
        name: "description",
        content: "Create roles and control exactly what each team can view, do and approve.",
      },
      { property: "og:title", content: "Roles & permissions — NEØ" },
      {
        property: "og:description",
        content: "Create roles and control exactly what each team can view, do and approve.",
      },
    ],
  }),
  component: GuardedPage,
});

type Role = {
  id: string;
  name: string;
  description: string;
  branch_scope: string;
  department_id: string | null;
  is_system: boolean;
  active: boolean;
  normalized_role_key: string | null;
};

function RolesPage() {
  const { organizationId, can, profile, user, refreshPermissions } = useAuth();
  // Managing roles is itself a granted permission, not a role name.
  const isAdmin = can("administration", "roles", "edit");
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const rolesQuery = useQuery({
    queryKey: ["roles", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase.from("roles").select("*").order("name");
      if (error) throw error;
      return (data ?? []) as Role[];
    },
  });

  const permissionsQuery = useQuery({
    queryKey: ["permissions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("permissions")
        .select("id, module, feature, action");
      if (error) throw error;
      return (data ?? []) as {
        id: string;
        module: string;
        feature: string | null;
        action: string;
      }[];
    },
  });

  const departmentsQuery = useScopedDepartments();

  const memberCounts = useQuery({
    queryKey: ["role-members", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase.from("user_roles").select("role_id");
      if (error) throw error;
      const counts: Record<string, number> = {};
      for (const r of data ?? [])
        counts[(r as { role_id: string }).role_id] =
          (counts[(r as { role_id: string }).role_id] ?? 0) + 1;
      return counts;
    },
  });

  const roles = rolesQuery.data ?? [];
  // Until the workspace is known the query is held back, and a held-back query
  // is not "loaded with zero roles" — it has simply not run yet.
  const rolesLoading = !organizationId || rolesQuery.isPending;
  const activeRole = roles.find((r) => r.id === selectedId) ?? roles[0] ?? null;

  const rolePermsQuery = useQuery({
    queryKey: ["role-permissions", activeRole?.id],
    enabled: Boolean(activeRole?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_permissions")
        .select("permission_id")
        .eq("role_id", activeRole!.id);
      if (error) throw error;
      return new Set((data ?? []).map((r) => (r as { permission_id: string }).permission_id));
    },
  });

  const permissionIndex = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of permissionsQuery.data ?? [])
      map.set(`${p.module}.${p.feature ?? "*"}.${p.action}`, p.id);
    return map;
  }, [permissionsQuery.data]);

  /**
   * Rows of the matrix: one per module *feature*, so a role can be given
   * Restaurant → Floor without also being given Reports, Settings or
   * Approvals. `*` is the whole-module row, kept for legacy broad grants.
   */
  const matrixRows = useMemo(() => {
    const byModule = new Map<string, Set<string>>();
    const registry: Record<string, string[]> = moduleFeatures();
    for (const module of Object.keys(registry)) {
      byModule.set(module, new Set(registry[module] ?? []));
    }
    for (const p of permissionsQuery.data ?? []) {
      const set = byModule.get(p.module) ?? new Set<string>();
      set.add(p.feature ?? "*");
      byModule.set(p.module, set);
    }
    return [...byModule.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([module, features]) => ({
        module,
        features: [...features].sort((a, b) =>
          a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b),
        ),
      }));
  }, [permissionsQuery.data]);

  /**
   * Permission editing is staged, not immediate. Ticking the matrix changes a
   * local draft for the selected role only; the draft is compared with the saved
   * state and the exact grants and removals are reviewed before anything is
   * written. The save still sends the whole selection, so the database routine
   * diffs it in one transaction, scoped to this role and this organisation.
   */
  const [draft, setDraft] = useState<{ roleId: string; ids: Set<string> } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const savedIds = rolePermsQuery.data ?? new Set<string>();
  const draftIds = draft && activeRole && draft.roleId === activeRole.id ? draft.ids : savedIds;

  const permissionRefs = useMemo(() => {
    const map = new Map<string, PermissionRef>();
    for (const p of permissionsQuery.data ?? [])
      map.set(p.id, { id: p.id, module: p.module, feature: p.feature, action: p.action });
    return map;
  }, [permissionsQuery.data]);

  const diff = useMemo(
    () => diffPermissionSets(savedIds, draftIds, permissionRefs),
    [savedIds, draftIds, permissionRefs],
  );
  const hasPendingChanges = !isEmptyDiff(diff);

  function toggleDraft(permissionId: string, on: boolean) {
    if (!activeRole) return;
    const base = draft && draft.roleId === activeRole.id ? draft.ids : savedIds;
    const next = new Set(base);
    if (on) next.add(permissionId);
    else next.delete(permissionId);
    setDraft({ roleId: activeRole.id, ids: next });
  }

  const savePermissions = useMutation({
    mutationFn: async () => {
      if (!activeRole || !organizationId) return;
      const { error } = await guardedRpc(supabase, "set_role_permissions", {
        _role: activeRole.id,
        _permission_ids: [...draftIds],
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      setDraft(null);
      setReviewOpen(false);
      toast.success(`Permissions saved · ${describePermissionDiff(diff)}`);
      // Re-fetch the saved state from the database rather than trusting local state.
      await qc.invalidateQueries({ queryKey: ["role-permissions", activeRole?.id] });
      await rolePermsQuery.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase.from("roles").update({ active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role updated");
      void qc.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const duplicateRole = useMutation({
    mutationFn: async (role: Role) => {
      if (!organizationId) return;
      const { data, error } = await supabase
        .from("roles")
        .insert({
          organization_id: organizationId,
          name: `${role.name} (copy)`,
          description: role.description,
          branch_scope: role.branch_scope,
          department_id: role.department_id,
        })
        .select("id")
        .single();
      if (error) throw error;
      const { data: perms } = await supabase
        .from("role_permissions")
        .select("permission_id")
        .eq("role_id", role.id);
      if (perms?.length) {
        // The permission set is resolved (template + overrides), so the copy is
        // written through the canonical writer rather than raw rows.
        const { error: copyError } = await guardedRpc(supabase, "set_role_permissions", {
          _role: (data as { id: string }).id,
          _permission_ids: perms.map((p) => (p as { permission_id: string }).permission_id),
        });
        if (copyError) throw copyError;
      }
    },
    onSuccess: () => {
      toast.success("Role duplicated");
      void qc.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        eyebrow="Organization"
        title="Roles & permissions"
        description="Roles group permissions. A permission is a module → feature → action capability, enforced identically in navigation, route guards, controls and database policies."
        actions={
          isAdmin ? (
            <div className="flex flex-wrap items-center gap-2">
              <ApplyTemplatesToOrganization />
              <Button onClick={() => setOpen(true)}>
                <Plus className="size-4" /> Create role
              </Button>
            </div>
          ) : null
        }

      />

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <SectionCard
          title="Roles"
          description={rolesLoading ? "Loading…" : `${roles.length} role(s)`}
        >
          {rolesLoading ? (
            <LoadingState variant="rows" rows={5} />
          ) : (
            <ul className="space-y-1">
              {roles.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => setSelectedId(r.id)}
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      activeRole?.id === r.id
                        ? "bg-primary-soft font-medium text-primary"
                        : "hover:bg-muted"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate">{r.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {memberCounts.data?.[r.id] ?? 0}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <div className="space-y-6">
          {activeRole ? (
            <>
              <SectionCard
                title={activeRole.name}
                description={activeRole.description || "No description"}
                actions={
                  isAdmin ? (
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        Active
                        <Switch
                          checked={activeRole.active}
                          onCheckedChange={(v) =>
                            toggleActive.mutate({ id: activeRole.id, active: v })
                          }
                        />
                      </label>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => duplicateRole.mutate(activeRole)}
                      >
                        <Copy className="size-4" /> Duplicate
                      </Button>
                      {activeRole.is_system ? null : (
                        <DeleteStructureRecord
                          kind="role"
                          id={activeRole.id}
                          name={activeRole.name}
                          invalidateKeys={[
                            ["roles", organizationId],
                            ["role-members", organizationId],
                            ["access-matrix-role-permissions"],
                          ]}
                          onDeleted={() => setSelectedId(null)}
                        />
                      )}
                    </div>
                  ) : null
                }
              >
                <div className="flex flex-wrap gap-3 text-sm">
                  <StatusPill tone={activeRole.active ? "success" : "warning"}>
                    {activeRole.active ? "Active" : "Inactive"}
                  </StatusPill>
                  <StatusPill tone="info">Branch scope: {activeRole.branch_scope}</StatusPill>
                  <StatusPill>
                    {memberCounts.data?.[activeRole.id] ?? 0} user(s) assigned
                  </StatusPill>
                  {activeRole.is_system ? <StatusPill>System role</StatusPill> : null}
                </div>
              </SectionCard>

              <RoleStructureCard roleName={activeRole.name} roleKey={activeRole.normalized_role_key} />

              {isAdmin ? (
                <RoleTemplatePanel
                  roleId={activeRole.id}
                  roleName={activeRole.name}
                  isAdmin={isAdmin}
                  onApplied={async () => {
                    await Promise.all([
                      qc.invalidateQueries({ queryKey: ["role-permissions", activeRole.id] }),
                      qc.invalidateQueries({ queryKey: ["role-template-diff", activeRole.id] }),
                      qc.invalidateQueries({ queryKey: ["access-matrix-role-permissions"] }),
                    ]);
                    await refreshPermissions();
                  }}
                />
              ) : null}

              <SectionCard
                title="Permission matrix"
                description="Permissions are module → feature → action. Tick the actions this role may perform on each individual feature; the whole-module row grants the feature set at once. Changes are staged for review before they are saved."
                actions={
                  isAdmin ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {describePermissionDiff(diff)}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!hasPendingChanges}
                        onClick={() => setDraft(null)}
                      >
                        Discard
                      </Button>
                      <Button
                        size="sm"
                        disabled={!hasPendingChanges}
                        onClick={() => setReviewOpen(true)}
                      >
                        Review &amp; save changes
                      </Button>
                    </div>
                  ) : null
                }
              >
                {hasPendingChanges ? (
                  <p className="mb-3 rounded-md border border-primary/40 bg-primary-soft px-3 py-2 text-xs text-primary">
                    {diff.added.length} permission(s) will be granted and {diff.removed.length}{" "}
                    removed for {activeRole.name}. Nothing is written until you review and save.
                  </p>
                ) : null}
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="py-2 text-left font-medium">Module &amp; feature</th>
                        {PERMISSION_ACTIONS.map((a) => (
                          <th
                            key={a}
                            className="px-1 py-2 text-center text-xs font-medium text-muted-foreground"
                          >
                            {actionLabels[a]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {matrixRows.map((row) => (
                        <Fragment key={row.module}>
                          <tr className="border-b border-border bg-muted/40">
                            <td
                              className="py-2 pr-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                              colSpan={PERMISSION_ACTIONS.length + 1}
                            >
                              {moduleLabels[row.module] ?? row.module}
                            </td>
                          </tr>
                          {row.features.map((f) => (
                            <tr key={`${row.module}.${f}`} className="border-b border-border/60">
                              <td className="py-2 pr-3 pl-4 font-medium">
                                {f === "*" ? "Whole module" : f.replace(/-/g, " ")}
                              </td>
                              {PERMISSION_ACTIONS.map((a) => {
                                const pid = permissionIndex.get(`${row.module}.${f}.${a}`);
                                const checked = pid ? draftIds.has(pid) : false;
                                const changed = pid ? savedIds.has(pid) !== checked : false;
                                return (
                                  <td key={a} className="px-1 py-2 text-center">
                                    <span
                                      className={
                                        changed
                                          ? "inline-flex rounded ring-2 ring-primary ring-offset-2 ring-offset-background"
                                          : undefined
                                      }
                                      title={
                                        changed
                                          ? "Pending change — review before saving"
                                          : undefined
                                      }
                                    >
                                      <Checkbox
                                        aria-label={`${moduleLabels[row.module] ?? row.module} ${f} ${actionLabels[a]}`}
                                        checked={checked}
                                        disabled={!isAdmin || !pid}
                                        onCheckedChange={(v) => pid && toggleDraft(pid, Boolean(v))}
                                      />
                                    </span>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionCard>
            </>
          ) : (
            <SectionCard
              title="No role selected"
              description="Create a role to configure permissions."
            >
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <ShieldCheck className="size-4" /> Nothing to show yet.
              </div>
            </SectionCard>
          )}
        </div>
      </div>

      <CreateRoleDialog
        open={open}
        onOpenChange={setOpen}
        departments={departmentsQuery.data ?? []}
        onCreate={async (payload) => {
          if (!organizationId) return;
          const { error } = await supabase
            .from("roles")
            .insert({ organization_id: organizationId, ...payload });
          if (error) throw error;
          void qc.invalidateQueries({ queryKey: ["roles"] });
        }}
      />

      <PermissionDiffDialog
        open={reviewOpen}
        roleName={activeRole?.name ?? ""}
        diff={diff}
        busy={savePermissions.isPending}
        onOpenChange={setReviewOpen}
        onConfirm={() => savePermissions.mutate()}
      />
    </div>
  );
}

/**
 * Before-and-after review of a staged permission change. The administrator sees
 * exactly which capabilities are being granted and which are being taken away,
 * grouped by module, and nothing is written until this is confirmed.
 */
function PermissionDiffDialog({
  open,
  roleName,
  diff,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  roleName: string;
  diff: ReturnType<typeof diffPermissionSets>;
  busy: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
}) {
  const labels = { modules: moduleLabels, actions: actionLabels };
  const sides = [
    { key: "added", title: "Being granted", tone: "success" as const, refs: diff.added },
    { key: "removed", title: "Being removed", tone: "warning" as const, refs: diff.removed },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review permission changes</DialogTitle>
          <DialogDescription>
            {roleName || "This role"} will hold {diff.total} capability(ies) after saving.{" "}
            {describePermissionDiff(diff)}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {sides.map((side) =>
            side.refs.length ? (
              <div key={side.key} className="space-y-2">
                <div className="flex items-center gap-2">
                  <StatusPill tone={side.tone}>{side.title}</StatusPill>
                  <span className="text-xs text-muted-foreground">{side.refs.length}</span>
                </div>
                {groupPermissionsByModule(side.refs).map((group) => (
                  <div key={group.module} className="rounded-md border p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {moduleLabels[group.module] ?? group.module}
                    </p>
                    <ul className="mt-1 space-y-0.5 text-sm">
                      {group.permissions.map((p) => (
                        <li key={p.id}>{permissionLabel(p, labels)}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : null,
          )}
          {isEmptyDiff(diff) ? (
            <p className="text-sm text-muted-foreground">There are no pending changes to review.</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Saving writes the complete selection for this role in one audited transaction.
              Everyone holding {roleName || "this role"} is affected at their next session refresh.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy || isEmptyDiff(diff)}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null} Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateRoleDialog({
  open,
  onOpenChange,
  departments,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  departments: { id: string; name: string }[];
  onCreate: (payload: {
    name: string;
    description: string;
    branch_scope: string;
    department_id: string | null;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [branchScope, setBranchScope] = useState("all");
  const [departmentId, setDepartmentId] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await onCreate({
        name,
        description,
        branch_scope: branchScope,
        department_id: departmentId || null,
      });
      toast.success("Role created");
      onOpenChange(false);
      setName("");
      setDescription("");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create custom role</DialogTitle>
          <DialogDescription>
            Set the scope now, then tick permissions in the matrix.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rname">Role name</Label>
            <Input id="rname" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rdesc">Description</Label>
            <Textarea
              id="rdesc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Branch scope</Label>
              <Select value={branchScope} onValueChange={setBranchScope}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All branches</SelectItem>
                  <SelectItem value="assigned">Assigned branches only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Department scope</Label>
              <Select value={departmentId} onValueChange={setDepartmentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Any department" />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create role
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type DiffRow = { module: string; action: string; status: string };

/**
 * Stage 7 — platform default role templates.
 *
 * Compares this role's live permissions against the versioned template that
 * matches its canonical key (including approved historical aliases), then lets
 * an administrator apply missing grants. A reset removes stale template grants
 * only; intentional custom grants remain visible and untouched.
 */
function RoleTemplatePanel({
  roleId,
  roleName,
  isAdmin,
  onApplied,
}: {
  roleId: string;
  roleName: string;
  isAdmin: boolean;
  onApplied: () => Promise<void>;
}) {
  const statusQuery = useQuery({
    queryKey: ["role-template-status", roleId],
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "recommended_role_template_status", { _role_id: roleId });
      if (error) throw error;
      return parseTemplateStatus(data);
    },
  });
  const diffQuery = useQuery({
    queryKey: ["role-template-diff", roleId],
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "recommended_role_diff", { _role_id: roleId });
      if (error) throw error;
      return (data ?? []) as DiffRow[];
    },
  });

  const queryClient = useQueryClient();

  const apply = useMutation({
    mutationFn: async (reset: boolean) => {
      const { data, error } = await guardedRpc(supabase, "apply_recommended_permissions", {
        _role_id: roleId,
        _reset: reset,
      });
      if (error) throw error;
      return { result: data, reset };
    },
    // Success is never assumed: the database reports what it verified, and the
    // diff is re-read before anything is shown to the administrator.
    onSuccess: async ({ result, reset }) => {
      const outcome = interpretApplyResult(result, reset);
      await queryClient.invalidateQueries({ queryKey: ["role-template-diff", roleId] });
      const refreshed = await diffQuery.refetch();
      const stillMissing = (refreshed.data ?? []).filter((r) => r.status === "add").length;
      await onApplied();
      if (outcome.kind !== "reconciled" || stillMissing > 0) {
        toast.error(
          stillMissing > 0
            ? `Not applied: ${stillMissing} permission${stillMissing === 1 ? "" : "s"} still missing for ${roleName}.`
            : outcome.message,
        );
        return;
      }
      toast.success(`${roleName}: ${outcome.message}`);
      if (outcome.unavailable > 0) {
        toast.warning(
          `${outcome.unavailable} template line${outcome.unavailable === 1 ? "" : "s"} no longer map to a live permission and were skipped.`,
        );
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = diffQuery.data ?? [];
  const missing = rows.filter((r) => r.status === "add");
  const custom = rows.filter((r) => r.status === "custom");
  const retained = rows.filter((r) => r.status === "retained");
  // Template lines with no live permission behind them can never be granted;
  // they are reported honestly instead of counting as "missing" forever.
  const unavailable = rows.filter((r) => r.status === "unavailable");
  const templateStatus = statusQuery.data?.status;
  const hasTemplate = templateStatus === "approved";


  return (
    <SectionCard
      title="Recommended template"
      description={`Platform default permission set for “${roleName}”.`}
      actions={
        isAdmin && hasTemplate ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={apply.isPending || missing.length === 0}
              onClick={() => apply.mutate(false)}
            >
              Apply missing ({missing.length})
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={apply.isPending}
              onClick={() => apply.mutate(true)}
            >
              Reset to template
            </Button>
          </div>
        ) : null
      }
    >
      {diffQuery.isLoading || statusQuery.isLoading ? (
        <LoadingState variant="rows" rows={3} />
      ) : diffQuery.isError || statusQuery.isError ? (
        <EmptyState
          inline
          title="Template status unavailable"
          description={(diffQuery.error ?? statusQuery.error as Error)?.message ?? "The role template could not be read."}
        />
      ) : !hasTemplate ? (
        <EmptyState
          inline
          title={templateStatus === "retired" ? "Retired platform role" : templateStatus === "incomplete" ? "Platform template is incomplete" : "Custom role — no platform template"}
          description={templateStatus === "retired"
            ? "This historical role is no longer assignable and cannot receive a platform template."
            : templateStatus === "incomplete"
              ? "This approved catalogue role has no template lines. Apply is disabled until the platform catalogue is corrected."
              : "This role is not mapped to an approved canonical hotel role. Configure it manually without changing its identity."}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3 text-sm">
            <StatusPill tone="success">{retained.length} aligned</StatusPill>
            <StatusPill tone={missing.length ? "warning" : "default"}>
              {missing.length} missing
            </StatusPill>
            <StatusPill tone="info">{custom.length} individual exception(s)</StatusPill>
            {unavailable.length ? (
              <StatusPill tone="warning">{unavailable.length} unavailable in this version</StatusPill>
            ) : null}

          </div>
          {missing.length ? (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Missing from this role
              </p>
              <div className="flex flex-wrap gap-1.5">
                {missing.map((r) => (
                  <span
                    key={`${r.module}:${r.action}`}
                    className="rounded-md border border-border bg-muted/60 px-2 py-1 text-xs"
                  >
                    {moduleLabels[r.module] ?? r.module} · {actionLabels[r.action] ?? r.action}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {custom.length ? (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Granted beyond the template
              </p>
              <div className="flex flex-wrap gap-1.5">
                {custom.map((r) => (
                  <span
                    key={`${r.module}:${r.action}`}
                    className="rounded-md border border-primary/30 bg-primary-soft px-2 py-1 text-xs text-primary"
                  >
                    {moduleLabels[r.module] ?? r.module} · {actionLabels[r.action] ?? r.action}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {unavailable.length ? (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Listed in the template but not available to grant
              </p>
              <div className="flex flex-wrap gap-1.5">
                {unavailable.map((r) => (
                  <span
                    key={`unavailable:${r.module}:${r.action}`}
                    className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning-foreground"
                  >
                    {moduleLabels[r.module] ?? r.module} · {actionLabels[r.action] ?? r.action}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

        </div>
      )}
    </SectionCard>
  );
}

/**
 * Where this role sits in the hotel's approved structure.
 *
 * The catalogue is the written organisation chart: department, reporting
 * line, how many people hold the role, how far their access reaches, and
 * whether they may approve restricted actions. Only the Owner/Director and
 * the Operations Manager hold that authority — everyone else submits a
 * request instead.
 */
function RoleStructureCard({ roleName, roleKey }: { roleName: string; roleKey: string | null }) {
  const { data: catalogue = [], isLoading } = useRoleCatalogue();
  const { data: restricted = [] } = useRestrictedActions();

  // Structure follows the immutable catalogue identity. Display-name equality
  // is retained only for old rows that genuinely pre-date canonical keys.
  const canonicalKey = roleKey && catalogue.some((c) => c.role_key === roleKey)
    ? roleKey
    : resolveCatalogueRoleKey(roleName);
  const entry = catalogue.find((c) => c.role_key === canonicalKey)
    ?? catalogue.find((c) => c.role_name === roleName);
  // Retired roles (for example the former Night Auditor) stay in the catalogue
  // for history only; they are never shown as part of the current structure.
  const current = catalogue.filter((c) => !c.retired);
  const reportsTo = entry?.reports_to_key
    ? current.find((c) => c.role_key === entry.reports_to_key)?.role_name
    : null;
  const reportees = entry ? current.filter((c) => c.reports_to_key === entry.role_key) : [];

  if (isLoading) {
    return (
      <SectionCard
        title="Position in the hotel structure"
        description="Reading the approved role catalogue."
      >
        <LoadingState variant="rows" rows={3} />
      </SectionCard>
    );
  }

  if (!entry) {
    return (
      <SectionCard
        title="Position in the hotel structure"
        description="This role is not part of the approved hotel role catalogue."
      >
        <p className="text-sm text-muted-foreground">
          Custom roles are still fully enforced, but they carry no documented reporting line. They
          can never approve restricted actions — voids, discounts, complimentary items, guest
          refunds, price overrides, reopening closed bills, reversing payments or removing posted
          charges remain with the Owner and Operations Manager only.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Position in the hotel structure" description={entry.summary}>
      <div className="flex flex-wrap gap-3 text-sm">
        <StatusPill tone="info">{entry.department}</StatusPill>
        <StatusPill>{multiplicityLabels[entry.multiplicity] ?? entry.multiplicity}</StatusPill>
        {entry.optional_role ? <StatusPill tone="warning">Optional role</StatusPill> : null}
        <StatusPill>Sees: {accessScopeLabels[entry.access_scope] ?? entry.access_scope}</StatusPill>
        <StatusPill tone={entry.restricted_authority ? "success" : "warning"}>
          {entry.restricted_authority
            ? "Approves restricted actions"
            : "May only request restricted actions"}
        </StatusPill>
      </div>

      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Answerable to</dt>
          <dd className="text-sm text-foreground">
            {reportsTo ?? "Business owners, directors or board"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Direct reports</dt>
          <dd className="text-sm text-foreground">
            {reportees.length ? reportees.map((r) => r.role_name).join(", ") : "None"}
          </dd>
        </div>
      </dl>

      {!entry.restricted_authority && restricted.length ? (
        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-xs font-medium text-foreground">Withheld from this role by policy</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {restrictedReasons(restricted).map((reason) => (
              <span
                key={reason}
                className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
              >
                {reason}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/roles">
      <RolesPage />
    </OpsGuard>
  );
}

/**
 * Bringing every role in this workspace up to its approved platform template.
 *
 * The routine behind this button is additive: it grants only what the template
 * asks for and a role does not yet have, so permissions this hotel configured
 * itself are never removed. Roles with no approved template are reported, not
 * guessed at, and the result is only called complete when the database
 * confirmed nothing is still missing.
 */
function ApplyTemplatesToOrganization() {
  const qc = useQueryClient();
  const [summary, setSummary] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_reconcile_org_role_templates", {});
      if (error) throw error;
      return data as unknown as {
        ok: boolean;
        roles: number;
        reconciled: number;
        incomplete: number;
        no_template: number;
        added: number;
      };
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["roles"] });
      await qc.invalidateQueries({ queryKey: ["role-template-diff"] });
      await qc.invalidateQueries({ queryKey: ["access-matrix-role-permissions"] });
      const line =
        `${r.reconciled} of ${r.roles} role${r.roles === 1 ? "" : "s"} reconciled · ` +
        `${r.added} permission${r.added === 1 ? "" : "s"} added` +
        (r.no_template > 0 ? ` · ${r.no_template} with no platform template (left as configured)` : "") +
        (r.incomplete > 0 ? ` · ${r.incomplete} still missing grants` : "");
      setSummary(line);
      if (r.incomplete > 0) toast.error(line);
      else toast.success(line);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" onClick={() => run.mutate()} disabled={run.isPending}>
        {run.isPending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
        Apply templates to all roles
      </Button>
      {summary ? <span className="text-xs text-muted-foreground">{summary}</span> : null}
    </div>
  );
}
