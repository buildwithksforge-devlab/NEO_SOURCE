/**
 * Canonical NEØ data-scope contract — rows, not navigation.
 *
 * Navigation permissions answer "may this person open the page". This module
 * answers the harder question every list, card, KPI, dropdown, report, task
 * inbox and mutation has to answer: "which rows are this person's business?"
 *
 * Three semantics, resolved from the backend effective-access facts only —
 * never from a role name, job title or e-mail:
 *
 *  - Self scope (waiter, barista, housekeeper, laundry attendant, rider,
 *    maintenance technician, line chef, receptionist where configured): only
 *    the work they created or are assigned, inside their assigned property.
 *    Waiter A never sees Waiter B's orders; Housekeeper A never sees
 *    Housekeeper B's jobs; Rider A only their own deliveries and shifts.
 *  - Department scope (supervisors and departmental managers): their own
 *    department's or team's rows, inside their assigned property only. Never
 *    another department, never another property.
 *  - Organisation scope (Owner/Director and IT/System Administration, equal
 *    superusers): every department and every property, including All
 *    Properties aggregation and property switching.
 *
 * Property is a hard boundary for everyone below organisation scope, applied
 * before ownership, so a row mis-stamped with another property still cannot be
 * read. This is a narrowing filter layered on top of RLS, never a replacement:
 * the database policies remain the authority.
 */

import { useCallback, useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { canModuleFromPermissions } from "@/lib/permissions";
import {
  resolveVisibility,
  scopeRank,
  type RecordFilter,
  type RecordSubject,
  type ScopeLevel,
  type VisibilityContract,
} from "@/lib/visibility-contract";

/**
 * How a table expresses each scope. `users` lists every column that identifies
 * the person whose work the row is — ownership *or* assignment, because a
 * waiter must keep seeing the order they raised and the housekeeper must see
 * the job they were given.
 *
 * A table absent from this map is reference/catalogue data (rooms, room types,
 * menus, price lists): it is property-filtered by `useActivePropertyFilter`
 * and never narrowed to one person, because line staff need it to do the work.
 */
export type TableScopeColumns = {
  branch?: string;
  department?: string;
  station?: string;
  users?: string[];
  /**
   * The module that owns this table when the rows carry no department column.
   * A departmental manager of that module reads the whole property queue —
   * the same reach `in_my_module_scope()` already grants in the policies —
   * instead of being narrowed to rows they personally created. Without it a
   * dispatch queue of customer-placed orders would look empty to the very
   * manager who has to assign them.
   */
  module?: string;
};

export const TABLE_SCOPE_COLUMNS: Record<string, TableScopeColumns> = {
  // ---- People / workforce -------------------------------------------------
  // `profiles.id` is the canonical login identity. Organisation-wide staff
  // may legitimately have no branch, so property treatment remains owned by
  // branch-filter.ts; these columns add department/team narrowing when the
  // caller uses the full data-scope contract.
  profiles: {
    branch: "branch_id",
    department: "department_id",
    users: ["id"],
  },
  // Employee rows are property-owned. `profile_id` links them back to the
  // canonical user identity used by self/team visibility.
  employees: {
    branch: "branch_id",
    department: "department_id",
    users: ["profile_id"],
  },

  // ---- Restaurant / bar / POS ---------------------------------------------
  pos_orders: {
    branch: "branch_id",
    department: "department_id",
    station: "station_id",
    users: ["waiter_id", "created_by"],
  },
  pos_shifts: { branch: "branch_id", station: "station_id", users: ["opened_by", "closed_by"] },
  bar_tabs: { branch: "branch_id", users: ["opened_by"] },
  // ---- Kitchen ------------------------------------------------------------
  station_tickets: {
    branch: "branch_id",
    department: "department_id",
    station: "station_id",
    users: ["assigned_chef_id", "created_by"],
  },
  production_batches: { branch: "branch_id", station: "station_id", users: ["created_by"] },
  waste_records: { branch: "branch_id", station: "station_id", users: ["recorded_by"] },
  // ---- Housekeeping / laundry / linen -------------------------------------
  housekeeping_jobs: {
    branch: "branch_id",
    department: "department_id",
    station: "station_id",
    users: ["assignee_id", "created_by"],
  },
  laundry_batches: {
    branch: "branch_id",
    department: "source_department_id",
    users: ["attendant_id", "created_by"],
  },
  guest_laundry_orders: { branch: "branch_id", users: ["assignee_id", "created_by"] },
  linen_movements: { branch: "branch_id", department: "from_department_id", users: ["performed_by"] },
  // ---- Front office -------------------------------------------------------
  guest_requests: {
    branch: "branch_id",
    department: "department_id",
    station: "station_id",
    users: ["assignee_id", "created_by"],
  },
  // ---- Maintenance / grounds / security ----------------------------------
  maintenance_work_orders: {
    branch: "branch_id",
    department: "requesting_department_id",
    users: ["assigned_to", "requested_by", "created_by"],
  },
  grounds_tasks: { branch: "branch_id", users: ["assignee_user_id", "created_by"] },
  security_patrols: { branch: "branch_id", users: ["assignee_id", "created_by"] },
  defects: { branch: "branch_id", users: ["reported_by"] },
  // ---- Delivery -----------------------------------------------------------
  delivery_orders: { branch: "branch_id", users: ["rider_id", "created_by"], module: "delivery" },
  rider_shifts: { branch: "branch_id", users: ["rider_id", "created_by"], module: "delivery" },
  // ---- Stores / procurement ----------------------------------------------
  internal_requisitions: {
    branch: "branch_id",
    department: "department_id",
    users: ["requested_by", "issued_by", "received_by"],
  },
  purchase_requests: { branch: "branch_id", department: "department_id", users: ["requested_by"] },
  stock_transfers: { branch: "branch_id", users: ["requested_by", "dispatched_by", "received_by"] },
  // ---- HR own-record surfaces --------------------------------------------
  attendance_records: { branch: "branch_id", department: "department_id", users: ["employee_id"] },
  leave_requests: { branch: "branch_id", department: "department_id", users: ["employee_id"] },
  expense_claims: { branch: "branch_id", department: "department_id", users: ["requested_by"] },
  // ---- Workflow -----------------------------------------------------------
  tasks: {
    branch: "branch_id",
    department: "department_id",
    station: "station_id",
    users: ["assignee_id", "created_by"],
  },
  event_banquet_tasks: { branch: "branch_id", users: ["assignee_user_id", "created_by"] },
  support_tickets: { branch: "branch_id", users: ["assigned_agent_id", "created_by"] },
};

/** True when the table carries per-person work that self scope must narrow. */
export function hasSelfScope(table: string): boolean {
  return (TABLE_SCOPE_COLUMNS[table]?.users?.length ?? 0) > 0;
}

/**
 * The Postgrest `or(...)` filter that keeps only this person's rows. Exported
 * so the regression tests can assert the exact predicate a screen will send.
 */
export function selfScopeFilter(table: string, userIds: string[]): string | null {
  const cols = TABLE_SCOPE_COLUMNS[table]?.users ?? [];
  if (!cols.length || !userIds.length) return null;
  return cols.flatMap((c) => userIds.map((id) => `${c}.eq.${id}`)).join(",");
}

export type DataScope = {
  level: ScopeLevel;
  /** Owner/Director and IT/System Administration only. */
  isOrgScope: boolean;
  /** Department/team reach inside the assigned property. */
  isDepartmentScope: boolean;
  /** Line-staff reach: own work only. */
  isSelfScope: boolean;
  userId: string | null;
  organizationId: string | null;
  /** Self plus anyone who reports to this person. */
  userIds: string[];
  branchIds: string[];
  departmentIds: string[];
  stationIds: string[];
  /** The selected property, or null when viewing All Properties. */
  activeBranchId: string | null;
  filter: RecordFilter;
  /**
   * Query-key fragment. Every scoped query must include it so switching user,
   * property or department can never serve another scope's cached rows.
   */
  scopeKey: string;
  visibility: VisibilityContract;
  canSeeRecord: (record: RecordSubject) => boolean;
  /** Narrows a Supabase query to this person's permitted rows for `table`. */
  applyScope: <T>(query: T, table: string) => T;
};

type Filterable<T> = {
  eq: (column: string, value: unknown) => T;
  in: (column: string, values: readonly unknown[]) => T;
  or: (filter: string) => T;
};

export function useDataScope(): DataScope {
  const { profile, user, organizationId, access, permissions } = useAuth();
  const { applyTo, branchId } = useActivePropertyFilter();

  const userId = profile?.id ?? user?.id ?? null;

  const visibility = useMemo(
    () =>
      resolveVisibility({
        userId,
        accountType: access.accountType,
        accountStatus: access.accountStatus,
        organizationId: organizationId ?? null,
        accessScope: access.accessScope,
        branchIds: access.branchIds,
        departmentIds: access.departmentIds,
        stationIds: access.stationIds,
        grants: permissions,
        entitlements: access.entitlements,
        setupComplete: access.setupComplete,
      }),
    [userId, organizationId, access, permissions],
  );

  const canModule = useMemo(() => canModuleFromPermissions(permissions), [permissions]);
  const level = visibility.level;
  const filter = useMemo(() => visibility.recordFilter(), [visibility]);

  const scopeKey = useMemo(
    () =>
      [
        level,
        userId ?? "anon",
        branchId ?? "all",
        [...filter.departmentIds].sort().join("+") || "-",
        [...filter.stationIds].sort().join("+") || "-",
      ].join(":"),
    [level, userId, branchId, filter.departmentIds, filter.stationIds],
  );

  const applyScope = useCallback(
    <T,>(query: T, table: string): T => {
      const cols = TABLE_SCOPE_COLUMNS[table] ?? {};
      const branchColumn = cols.branch ?? "branch_id";

      // 1 — Property. The selected property always narrows; with All Properties
      // selected, a non-organisation account is still pinned to its assignments.
      let q = applyTo(query, table, branchColumn);
      const orgWide = scopeRank(level) >= scopeRank("organization");
      if (!orgWide && !branchId && filter.branchIds.length) {
        q = (q as unknown as Filterable<T>).in(branchColumn, filter.branchIds);
      }
      if (orgWide) return q;

      // 2 — Department / station, inside that property.
      if (level === "department") {
        if (cols.department && filter.departmentIds.length) {
          return (q as unknown as Filterable<T>).in(cols.department, filter.departmentIds);
        }
        if (cols.station && filter.stationIds.length) {
          return (q as unknown as Filterable<T>).in(cols.station, filter.stationIds);
        }
        // A module-owned table (dispatch queues, rider shifts) is the whole
        // department's work even though the row carries no department column.
        // RLS already allows it through in_my_module_scope(); narrowing to the
        // manager's own rows here would hide customer-placed orders entirely.
        if (cols.module && canModule(cols.module, "view")) return q;
        // Otherwise it cannot be widened on a guess; the manager sees their
        // team's own rows instead.
        const teamFilter = selfScopeFilter(table, filter.userIds);
        return teamFilter ? (q as unknown as Filterable<T>).or(teamFilter) : q;
      }
      if (level === "station") {
        if (cols.station && filter.stationIds.length) {
          return (q as unknown as Filterable<T>).in(cols.station, filter.stationIds);
        }
        const own = selfScopeFilter(table, filter.userIds);
        return own ? (q as unknown as Filterable<T>).or(own) : q;
      }

      // 3 — Self. Own and reports' work only; peers are invisible.
      const own = selfScopeFilter(table, filter.userIds);
      return own ? (q as unknown as Filterable<T>).or(own) : q;
    },
    [applyTo, branchId, canModule, filter.branchIds, filter.departmentIds, filter.stationIds, filter.userIds, level],
  );

  return {
    level,
    isOrgScope: scopeRank(level) >= scopeRank("organization"),
    isDepartmentScope: level === "department" || level === "property",
    isSelfScope: level === "personal" || level === "station",
    userId,
    organizationId: organizationId ?? null,
    userIds: filter.userIds,
    branchIds: filter.branchIds,
    departmentIds: filter.departmentIds,
    stationIds: filter.stationIds,
    activeBranchId: branchId,
    filter,
    scopeKey,
    visibility,
    canSeeRecord: visibility.canSeeRecord,
    applyScope,
  };
}
