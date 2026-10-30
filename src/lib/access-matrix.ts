/**
 * Live administrative Access Matrix (L.21).
 *
 * Every row is generated from the database — the organisation's real roles and
 * their saved grants — and compared against the recommended catalogue template
 * compiled by `public.neo_apply_feature_templates()`. Nothing is hardcoded per
 * role: a custom role created today appears in the matrix immediately.
 */

import { guardedRpc } from "@/lib/rpc-guard";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ROUTE_CAPABILITIES, moduleFeatures } from "@/lib/capabilities";
import { addGrant } from "@/lib/permissions";
import {
  ROLE_ACCESS_SCOPES,
  ROLE_FEATURE_TEMPLATES,
  compileRoleTemplate,
  type RoleAccessScope,
} from "@/lib/role-templates";
import { COST_CAPABILITIES, scopeLevelFor, type ScopeLevel } from "@/lib/visibility-contract";
import { useOrgRoles, useRoleDashboardAssignments, type OrgRole } from "@/lib/workspace-preview-data";

export const ACCESS_MATRIX_VERSION = "modern-hotel-structure-v2.0";

export type MatrixRow = {
  roleId: string;
  role: string;
  roleKey: string | null;
  department: string;
  station: string;
  dashboard: string;
  permission: string;
  page: string;
  action: string;
  recordScope: ScopeLevel;
  approval: string;
  costVisibility: string;
  reports: string;
  notifications: string;
  tasks: string;
  source: string;
  customization: string;
  individualOverride: string;
  effective: "granted" | "denied";
  recommended: "granted" | "denied";
  agrees: boolean;
};

/** Saved grants for every role, expanded exactly as a live session expands them. */
export function useAllRolePermissions() {
  return useQuery({
    queryKey: ["access-matrix-role-permissions"],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_permissions")
        .select("role_id, permissions(module, feature, action)");
      if (error) throw error;
      const byRole = new Map<string, Set<string>>();
      for (const row of (data ?? []) as unknown as {
        role_id: string;
        permissions: { module: string; feature: string | null; action: string } | null;
      }[]) {
        if (!row.permissions) continue;
        const set = byRole.get(row.role_id) ?? new Set<string>();
        addGrant(set, row.permissions.module, row.permissions.feature, row.permissions.action);
        byRole.set(row.role_id, set);
      }
      return byRole;
    },
  });
}

/** Per-user grants and denials layered on top of a role (individual override). */
export function useIndividualOverrides() {
  return useQuery({
    queryKey: ["access-matrix-individual-overrides"],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_permissions")
        .select("user_id, permission_id, effect");
      if (error) return new Map<string, number>();
      const counts = new Map<string, number>();
      for (const row of (data ?? []) as { user_id: string }[]) {
        counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
      }
      return counts;
    },
  });
}

function useDepartmentNames() {
  return useQuery({
    queryKey: ["access-matrix-departments"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("departments").select("id, name");
      if (error) throw error;
      return new Map(((data ?? []) as { id: string; name: string }[]).map((d) => [d.id, d.name]));
    },
  });
}

const has = (set: Set<string> | undefined, module: string, feature: string, action: string) =>
  Boolean(
    set &&
      (set.has(`${module}.${feature}.${action}`) ||
        set.has(`${module}.*.${action}`) ||
        set.has(`${module}:${action}`)),
  );

function scopeForRole(role: OrgRole, key: string | null): RoleAccessScope {
  return (key && ROLE_ACCESS_SCOPES[key]) || "self";
}

function levelFor(scope: RoleAccessScope): ScopeLevel {
  return scopeLevelFor({
    userId: "x",
    accountType: "staff",
    accountStatus: "active",
    organizationId: "x",
    accessScope: scope,
    branchIds: ["b"],
    departmentIds: ["d"],
    stationIds: ["s"],
    grants: new Set(),
    entitlements: {},
    setupComplete: true,
  });
}

/** Builds the full matrix: role × capability, effective vs recommended. */
export function useAccessMatrix() {
  const roles = useOrgRoles();
  const grants = useAllRolePermissions();
  const dashboards = useRoleDashboardAssignments();
  const departments = useDepartmentNames();
  const overrides = useIndividualOverrides();

  const features = useMemo(() => moduleFeatures(), []);

  const rows = useMemo<MatrixRow[]>(() => {
    if (!roles.data || !grants.data) return [];
    const dashboardByRole = new Map<string, string>();
    for (const d of (dashboards.data ?? []) as { role_id: string; dashboard_key: string }[]) {
      if (!dashboardByRole.has(d.role_id)) dashboardByRole.set(d.role_id, d.dashboard_key);
    }
    const out: MatrixRow[] = [];
    for (const role of roles.data) {
      const key = role.normalized_role_key;
      const scope = scopeForRole(role, key);
      const level = levelFor(scope);
      const held = grants.data.get(role.id);
      const recommendedSet = new Set<string>();
      if (key && ROLE_FEATURE_TEMPLATES[key]) {
        for (const g of compileRoleTemplate(key, features)) {
          addGrant(recommendedSet, g.module, g.feature, g.action);
        }
      }
      const costKeys = (Object.keys(COST_CAPABILITIES) as (keyof typeof COST_CAPABILITIES)[])
        .filter((c) => {
          const cap = COST_CAPABILITIES[c];
          return has(held, cap.module, cap.feature, cap.action);
        })
        .join(", ");

      for (const entry of ROUTE_CAPABILITIES) {
        const action = entry.action ?? "view";
        const effective = has(held, entry.module, entry.feature, action);
        const recommended = has(recommendedSet, entry.module, entry.feature, action);
        const approves = has(held, entry.module, entry.feature, "approve");
        out.push({
          roleId: role.id,
          role: role.name,
          roleKey: key,
          department: role.department_id
            ? (departments.data?.get(role.department_id) ?? "—")
            : "—",
          station: level === "station" ? "Assigned stations" : "—",
          dashboard: dashboardByRole.get(role.id) ?? "—",
          permission: `${entry.module}.${entry.feature}.${action}`,
          page: entry.prefix,
          action,
          recordScope: level,
          approval: approves ? "May decide" : "Request only",
          costVisibility: costKeys || "None",
          reports: has(held, "reports", "overview", "view")
            ? "Reports"
            : has(held, "analytics", "overview", "view")
              ? "Executive analytics"
              : "Personal only",
          notifications: level,
          tasks: level === "personal" ? "Own tasks" : `${level} tasks`,
          source: key && ROLE_FEATURE_TEMPLATES[key] ? ACCESS_MATRIX_VERSION : "Custom role",
          customization: effective && !recommended ? "Added by organisation" : "—",
          individualOverride: "See user overrides",
          effective: effective ? "granted" : "denied",
          recommended: recommended ? "granted" : "denied",
          agrees: effective === recommended,
        });
      }
    }
    return out;
  }, [roles.data, grants.data, dashboards.data, departments.data, features]);

  return {
    rows,
    loading: roles.isLoading || grants.isLoading,
    error: roles.error ?? grants.error ?? null,
    overrides: overrides.data ?? new Map<string, number>(),
    refetch: async () => {
      await Promise.all([roles.refetch(), grants.refetch()]);
    },
  };
}

export function matrixToCsv(rows: MatrixRow[]): string {
  const headers = [
    "Role",
    "Role key",
    "Department",
    "Station",
    "Dashboard",
    "Permission",
    "Page/route",
    "Action",
    "Record scope",
    "Approval authority",
    "Cost visibility",
    "Reports",
    "Notifications",
    "Tasks",
    "Source template",
    "Organisation customisation",
    "Individual override",
    "Effective result",
    "Recommended",
  ];
  const escape = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      r.role,
      r.roleKey ?? "",
      r.department,
      r.station,
      r.dashboard,
      r.permission,
      r.page,
      r.action,
      r.recordScope,
      r.approval,
      r.costVisibility,
      r.reports,
      r.notifications,
      r.tasks,
      r.source,
      r.customization,
      r.individualOverride,
      r.effective,
      r.recommended,
    ]
      .map(escape)
      .join(","),
  );
  return [headers.map(escape).join(","), ...lines].join("\n");
}

/** Re-compiles the recommended catalogue templates for the organisation. */
export async function applyRecommendedTemplates(organizationId: string) {
  const { data, error } = await guardedRpc(supabase, "neo_apply_feature_templates", {
    _org: organizationId,
  });
  if (error) throw error;
  return data;
}
