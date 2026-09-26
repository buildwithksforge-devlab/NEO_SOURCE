/**
 * The permanent staff assignment chain.
 *
 * Every staff account resolves through exactly one chain:
 *
 *   Organisation → Property → Department → Role → Station/Section →
 *   Reporting Manager → Record Scope
 *
 * Nothing in the product may infer any link of that chain from a job title.
 * An account becomes *operationally active* only when every step the account's
 * roles genuinely require is complete; until then the workspace says so plainly
 * instead of rendering empty operational screens.
 *
 * This module is the single canonical resolver: the administrator's assignment
 * dialog validates against it, the employee's own workspace notice explains
 * itself with it, and the visibility contract derives workspace status from it,
 * so the interface and the backend never disagree about who is active.
 */

import { ROLE_ACCESS_SCOPES, type RoleAccessScope } from "./role-templates";
import { resolveCatalogueRoleKey } from "./role-aliases";

/** Record scope levels, narrowest first — the visible half of L.1. */
export const RECORD_SCOPES = [
  "personal",
  "station",
  "section",
  "department",
  "property",
  "organization",
] as const;

export type RecordScope = (typeof RECORD_SCOPES)[number];

export const RECORD_SCOPE_LABELS: Record<RecordScope, string> = {
  personal: "Own assignments and records",
  station: "Tickets for explicitly assigned station(s)",
  section: "Their team / section / station",
  department: "Their department within the assigned property",
  property: "Entire assigned property",
  organization: "Organisation and all authorised properties",
};

/**
 * Roles whose work is produced at, or sold from, one explicitly assigned
 * station. The role alone never chooses the station: an administrator assigns
 * the employee to one or more *existing* stations of their property, and the
 * account stays inactive until at least one is assigned.
 */
export const STATION_REQUIRED_ROLE_KEYS = new Set([
  "waiter",
  "barista",
  "bar-attendant",
  "hot-kitchen-chef",
  "pastry-chef",
  "kitchen-steward",
  "coffee-station-supervisor",
  "hot-kitchen-supervisor",
]);

/**
 * Roles that legitimately sit at the top of a reporting line, so a missing
 * reporting manager is a correct state rather than an incomplete assignment.
 */
export const TOP_OF_LINE_ROLE_KEYS = new Set(["owner", "it-system-administrator"]);

/** Roles whose reach is organisation-wide, so a single property is not required. */
const ORG_WIDE_SCOPES: RoleAccessScope[] = ["organisation", "technical"];

const SCOPE_RECORD_SCOPE: Record<RoleAccessScope, RecordScope> = {
  organisation: "organization",
  technical: "organization",
  branch: "property",
  department: "department",
  team: "section",
  self: "personal",
};

/** Canonical catalogue key for a stored role name; `null` when unrecognised. */
export function roleKeyOf(name: string): string | null {
  return resolveCatalogueRoleKey(name);
}

export function roleKeysOf(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const key = roleKeyOf(n);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Widest access scope across the account's roles. */
export function accessScopeForRoles(roleKeys: string[]): RoleAccessScope | null {
  const order: RoleAccessScope[] = ["self", "team", "department", "branch", "technical", "organisation"];
  let best: RoleAccessScope | null = null;
  for (const key of roleKeys) {
    const scope = ROLE_ACCESS_SCOPES[key];
    if (!scope) continue;
    if (!best || order.indexOf(scope) > order.indexOf(best)) best = scope;
  }
  return best;
}

/**
 * The record scope the account's roles resolve to. A station-bound line role
 * resolves to `station`, not merely `personal`, because its work arrives as
 * station tickets rather than as personally owned records.
 */
export function recordScopeForRoles(roleKeys: string[]): RecordScope | null {
  const scope = accessScopeForRoles(roleKeys);
  if (!scope) return null;
  const base = SCOPE_RECORD_SCOPE[scope];
  if (base === "personal" && roleKeys.some((k) => STATION_REQUIRED_ROLE_KEYS.has(k))) {
    return "station";
  }
  return base;
}

export function requiresStation(roleKeys: string[]): boolean {
  return roleKeys.some((k) => STATION_REQUIRED_ROLE_KEYS.has(k));
}

export function requiresReportingManager(roleKeys: string[]): boolean {
  if (roleKeys.length === 0) return false;
  return !roleKeys.every((k) => TOP_OF_LINE_ROLE_KEYS.has(k));
}

export function requiresProperty(roleKeys: string[]): boolean {
  const scope = accessScopeForRoles(roleKeys);
  if (!scope) return true;
  return !ORG_WIDE_SCOPES.includes(scope);
}

export function requiresDepartment(roleKeys: string[]): boolean {
  const scope = accessScopeForRoles(roleKeys);
  if (!scope) return true;
  return !ORG_WIDE_SCOPES.includes(scope) && scope !== "branch";
}

export type ChainStepKey =
  | "organisation"
  | "property"
  | "department"
  | "role"
  | "station"
  | "reporting-manager"
  | "record-scope";

export type ChainStepStatus = "complete" | "missing" | "not-required";

export type ChainStep = {
  key: ChainStepKey;
  label: string;
  status: ChainStepStatus;
  /** Plain-language detail: what is set, or exactly what is still needed. */
  detail: string;
  /**
   * Whether the outstanding step actually stops work.
   *
   * Business policy decides this, and the answer must be applied
   * consistently: a link that does not stop work must not raise a blocking
   * "account setup required" banner either. A missing reporting manager
   * leaves the account fully operational, so it is tracked as a data-quality
   * task instead of a barrier.
   */
  blocking: boolean;
};

export type AssignmentChainInput = {
  organizationId: string | null;
  branchIds: string[];
  departmentIds: string[];
  stationIds: string[];
  /** Stored role names or catalogue keys — normalised internally. */
  roleNames: string[];
  reportingManagerId: string | null;
};

export type AssignmentChain = {
  roleKeys: string[];
  recordScope: RecordScope | null;
  steps: ChainStep[];
  /** Outstanding steps that genuinely stop work, in chain order. */
  missing: ChainStep[];
  /** Outstanding steps that do not stop work — a data-quality backlog. */
  dataQuality: ChainStep[];
  /** True only when every required step of the chain is complete. */
  operationallyActive: boolean;
};

const STEP_LABELS: Record<ChainStepKey, string> = {
  organisation: "Organisation",
  property: "Property",
  department: "Department",
  role: "Role",
  station: "Station / section",
  "reporting-manager": "Reporting manager",
  "record-scope": "Record scope",
};

/** Links whose absence is recorded but never blocks the account. */
const NON_BLOCKING_STEPS = new Set<ChainStepKey>(["reporting-manager"]);

function step(key: ChainStepKey, status: ChainStepStatus, detail: string): ChainStep {
  return {
    key,
    label: STEP_LABELS[key],
    status,
    detail,
    blocking: !NON_BLOCKING_STEPS.has(key),
  };
}

/**
 * Resolves the whole chain for one account. Pure, so the administrator's
 * dialog, the employee's notice and the automated matrix all agree.
 */
export function resolveAssignmentChain(input: AssignmentChainInput): AssignmentChain {
  const roleKeys = roleKeysOf(input.roleNames);
  const recordScope = recordScopeForRoles(roleKeys);
  const steps: ChainStep[] = [];

  steps.push(
    input.organizationId
      ? step("organisation", "complete", "Linked to an organisation")
      : step("organisation", "missing", "No organisation membership"),
  );

  const propertyNeeded = requiresProperty(roleKeys);
  steps.push(
    input.branchIds.length > 0
      ? step("property", "complete", `${input.branchIds.length} property assignment(s)`)
      : propertyNeeded
        ? step("property", "missing", "Assign the property this account works at")
        : step("property", "not-required", "Organisation-wide role — all authorised properties"),
  );

  const departmentNeeded = requiresDepartment(roleKeys);
  steps.push(
    input.departmentIds.length > 0
      ? step("department", "complete", `${input.departmentIds.length} department assignment(s)`)
      : departmentNeeded
        ? step("department", "missing", "Assign a department of the selected property")
        : step("department", "not-required", "Role reaches beyond a single department"),
  );

  steps.push(
    roleKeys.length > 0 || input.roleNames.length > 0
      ? step("role", "complete", `${input.roleNames.length} role(s) assigned`)
      : step("role", "missing", "Assign at least one role"),
  );

  const stationNeeded = requiresStation(roleKeys);
  steps.push(
    input.stationIds.length > 0
      ? step("station", "complete", `${input.stationIds.length} station assignment(s)`)
      : stationNeeded
        ? step("station", "missing", "This role only works station tickets — assign an existing station")
        : step("station", "not-required", "Role is not bound to a single station"),
  );

  const managerNeeded = requiresReportingManager(roleKeys);
  steps.push(
    input.reportingManagerId
      ? step("reporting-manager", "complete", "Reporting line recorded")
      : managerNeeded
        ? step(
            "reporting-manager",
            "missing",
            "Reporting line not recorded yet — this does not stop work",
          )
        : step("reporting-manager", "not-required", "Top of the reporting line"),
  );

  steps.push(
    recordScope
      ? step("record-scope", "complete", RECORD_SCOPE_LABELS[recordScope])
      : step("record-scope", "missing", "No recognised role, so no record scope resolves"),
  );

  const outstanding = steps.filter((s) => s.status === "missing");
  const missing = outstanding.filter((s) => s.blocking);
  const dataQuality = outstanding.filter((s) => !s.blocking);
  return {
    roleKeys,
    recordScope,
    steps,
    missing,
    dataQuality,
    operationallyActive: missing.length === 0,
  };
}
