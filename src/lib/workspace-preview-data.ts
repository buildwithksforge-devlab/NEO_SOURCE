import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { addGrant } from "./permissions";

export type OrgRole = {
  id: string;
  name: string;
  description: string | null;
  active: boolean | null;
  normalized_role_key: string | null;
  role_status: string | null;
  department_id: string | null;
  position_level: number | null;
};

/** All roles configured for the organisation — the live catalogue, not a static list. */
export function useOrgRoles(enabled = true) {
  return useQuery({
    queryKey: ["preview-roles"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("roles")
        .select("id, name, description, active, normalized_role_key, role_status, department_id, position_level")
        .neq("role_status", "archived")
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as OrgRole[];
    },
  });
}


/**
 * Real permission grants of one role, expanded exactly the way a signed-in
 * session expands them. Previewing a role therefore reports the same access
 * the user actually receives after logging in.
 */
export function useRolePermissions(roleId: string | null) {
  return useQuery({
    queryKey: ["preview-role-permissions", roleId],
    enabled: Boolean(roleId),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_permissions")
        .select("permissions(module, feature, action)")
        .eq("role_id", roleId!);
      if (error) throw error;
      const set = new Set<string>();
      for (const row of data ?? []) {
        const p = (
          row as unknown as {
            permissions: { module: string; feature: string | null; action: string } | null;
          }
        ).permissions;
        if (p) addGrant(set, p.module, p.feature, p.action);
      }
      return set;
    },
  });
}


/** Dashboard keys assigned to each role in the database. */
export function useRoleDashboardAssignments(enabled = true) {
  return useQuery({
    queryKey: ["preview-role-dashboards"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_dashboard_assignments")
        .select("role_id, dashboard_key, priority, is_default");
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Permission grant counts per role — used by the Role Testing checklist. */
export function useRolePermissionCounts(enabled = true) {
  return useQuery({
    queryKey: ["preview-role-permission-counts"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("role_permissions").select("role_id");
      if (error) throw error;
      const counts: Record<string, number> = {};
      for (const row of (data ?? []) as { role_id: string }[]) {
        counts[row.role_id] = (counts[row.role_id] ?? 0) + 1;
      }
      return counts;
    },
  });
}

export type RoleAccount = {
  user_id: string;
  role_id: string;
  is_primary: boolean;
  full_name: string | null;
  email: string | null;
  account_status: string | null;
  last_login_at: string | null;
  staff_id: string | null;
  job_title: string | null;
  department: string | null;
  property: string | null;
};

/**
 * Real staff accounts holding each role, keyed by role UUID.
 *
 * The assignment table carries no PostgREST relationship to `profiles`, so an
 * embedded select silently failed and every role reported "no accounts" even
 * when User Management showed people assigned. Matching is done here on the
 * role UUID and the user UUID — never on a role name.
 */
export function useRoleAccounts(enabled = true) {
  return useQuery({
    queryKey: ["preview-role-accounts"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const [assignments, profiles, departments, branches] = await Promise.all([
        supabase.from("user_roles").select("role_id, user_id, is_primary"),
        supabase
          .from("profiles")
          .select(
            "id, full_name, email, account_status, last_login_at, staff_id, job_title, department_id, branch_id",
          ),
        supabase.from("departments").select("id, name"),
        supabase.from("branches").select("id, name"),
      ]);
      if (assignments.error) throw assignments.error;
      if (profiles.error) throw profiles.error;

      const deptName = new Map(
        ((departments.data ?? []) as { id: string; name: string }[]).map((d) => [d.id, d.name]),
      );
      const branchName = new Map(
        ((branches.data ?? []) as { id: string; name: string }[]).map((b) => [b.id, b.name]),
      );
      const profileById = new Map(
        (
          (profiles.data ?? []) as unknown as {
            id: string;
            full_name: string | null;
            email: string | null;
            account_status: string | null;
            last_login_at: string | null;
            staff_id: string | null;
            job_title: string | null;
            department_id: string | null;
            branch_id: string | null;
          }[]
        ).map((p) => [p.id, p]),
      );

      const byRole: Record<string, RoleAccount[]> = {};
      for (const row of (assignments.data ?? []) as unknown as {
        role_id: string;
        user_id: string;
        is_primary: boolean | null;
      }[]) {
        const p = profileById.get(row.user_id);
        if (!p) continue; // assignment for an account outside this organisation's scope
        (byRole[row.role_id] ??= []).push({
          user_id: row.user_id,
          role_id: row.role_id,
          is_primary: Boolean(row.is_primary),
          full_name: p.full_name,
          email: p.email,
          account_status: p.account_status,
          last_login_at: p.last_login_at,
          staff_id: p.staff_id,
          job_title: p.job_title,
          department: p.department_id ? (deptName.get(p.department_id) ?? null) : null,
          property: p.branch_id ? (branchName.get(p.branch_id) ?? null) : null,
        });
      }
      for (const list of Object.values(byRole)) {
        list.sort((a, b) => (a.full_name ?? "").localeCompare(b.full_name ?? ""));
      }
      return byRole;
    },
  });
}

