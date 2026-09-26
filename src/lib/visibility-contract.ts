/**
 * L — Dynamic workspace, department, station and record-visibility contract.
 *
 * One configurable contract answers every visibility question in the OS:
 * which workspace, which pages, which records, which actions, which approvals,
 * which tasks and notifications, which reports and figures, and at which
 * organisational scope. Nothing here reads a role title. Effective visibility
 * is computed only from facts the backend already resolves for the session
 * (`public.my_effective_access()`): account type and status, organisation
 * membership, property / department / station assignment, saved permissions,
 * individual grants and denials, module entitlement, record ownership and
 * assignment, and the stored reporting relationship.
 *
 * The same contract powers the sidebar, the route guard, the buttons, the
 * selectors, the task and notification inboxes and the report figures, so a
 * new or custom role needs no code change: give it capabilities and scopes and
 * the whole workspace follows.
 */

import { pathPermitted } from "./capabilities";
import { canonicalPermission, actionClass, featureKey, permissionKey } from "./permissions";
import { resolveAssignmentChain } from "./assignment-chain";

/** Independent organisational visibility levels (L.1), narrowest first. */
export const SCOPE_LEVELS = [
  "personal",
  "station",
  "department",
  "property",
  "organization",
  "platform",
] as const;

export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

export const scopeRank = (level: ScopeLevel) => SCOPE_LEVELS.indexOf(level);

/** Backend access scope → contract scope level. Platform is never inferred. */
const ACCESS_SCOPE_LEVEL: Record<string, ScopeLevel> = {
  organisation: "organization",
  // Both spellings, so a stored "organization" scope is never silently
  // downgraded to self scope.
  organization: "organization",
  org: "organization",
  branch: "property",
  property: "property",

  department: "department",
  team: "department",
  self: "personal",
  // IT/System Administration is a superuser scope with the same platform reach
  // as Owner/Director: every property, every module, All Properties. The
  // "technical" label governs *commercial approval authority* — which the
  // organisation's approval matrix decides — never data reach.
  technical: "organization",
};

/** Capability that must be granted explicitly for NEØ platform administration. */
export const PLATFORM_CAPABILITY = { module: "platform", feature: "operations", action: "edit" };

export type VisibilityFacts = {
  userId: string | null;
  accountType: string | null;
  accountStatus: string | null;
  organizationId: string | null;
  /** Backend access scope from the effective-access resolver. */
  accessScope: string | null;
  branchIds: string[];
  departmentIds: string[];
  stationIds: string[];
  /** Expanded grant keys, exactly as `addGrant()` writes them. */
  grants: Set<string>;
  /** Explicit per-user denials, as `module.feature.action` keys. */
  denials?: Set<string>;
  entitlements: Record<string, boolean>;
  setupComplete: boolean;
  /** Stable reporting relationships — subordinate user ids, never names. */
  subordinateUserIds?: string[];
  /**
   * Stored role names for the account. When present, workspace status also
   * requires the permanent assignment chain (Organisation → Property →
   * Department → Role → Station/Section → Reporting Manager → Record Scope)
   * to be complete, so a station-bound account with no station is never
   * treated as operationally active.
   */
  roleNames?: string[];
  reportingManagerId?: string | null;

};

export type WorkspaceStatus = "ready" | "setup-incomplete" | "suspended" | "no-account";

/** Scope a query or list must be narrowed to before it is rendered. */
export type RecordFilter = {
  level: ScopeLevel;
  organizationId: string | null;
  branchIds: string[];
  departmentIds: string[];
  stationIds: string[];
  /** Only these users' records are visible at personal level (self + reports). */
  userIds: string[];
};

export type SelectorScope = {
  /** "All …" is offered only when the level genuinely reaches that far. */
  allowAll: boolean;
  ids: string[];
  /** No assignment at all — the screen must say Setup Incomplete, not "all". */
  setupIncomplete: boolean;
};

/** Confidential figures that each require their own capability (L.18). */
export const COST_CAPABILITIES = {
  "menu-cost": { module: "restaurant", feature: "menu", action: "view_costs" },
  "recipe-cost": { module: "kitchen", feature: "recipes", action: "view_costs" },
  "production-cost": { module: "kitchen", feature: "reports", action: "view_costs" },
  "inventory-valuation": { module: "stores", feature: "valuation", action: "view" },
  "supplier-pricing": { module: "procurement", feature: "suppliers", action: "view_costs" },
  payroll: { module: "human-resources", feature: "payroll", action: "view" },
  profitability: { module: "analytics", feature: "profitability", action: "view" },
  "financial-statements": { module: "finance", feature: "reports", action: "view" },
} as const;

export type CostKey = keyof typeof COST_CAPABILITIES;

/** Report tiers, narrowest first — each needs its own capability and scope. */
export const REPORT_TIERS = ["personal", "station", "department", "property", "organization"] as const;
export type ReportTier = (typeof REPORT_TIERS)[number];

export type VisibilityContract = {
  facts: VisibilityFacts;
  status: WorkspaceStatus;
  level: ScopeLevel;
  isPlatformAdmin: boolean;
  /** Raw capability check — grants minus denials, gated by entitlement. */
  can: (module: string, featureOrAction: string, action?: string) => boolean;
  /** Page visibility: sidebar link, module tab and route guard all use this. */
  canSeePage: (path: string) => boolean;
  /** Button / action authority — identical to what the backend will allow. */
  canAct: (module: string, feature: string, action: string) => boolean;
  /** Approval decision authority; self-approval is always refused. */
  canDecide: (module: string, feature: string, requesterUserId?: string | null) => boolean;
  /** Record scope for a module's lists and figures. */
  recordFilter: (module?: string, feature?: string) => RecordFilter;
  /** Whether a specific record is visible under ownership / assignment rules. */
  canSeeRecord: (record: RecordSubject) => boolean;
  /** Task inbox scope. */
  taskFilter: () => RecordFilter;
  /** Whether a notification addressed to an audience reaches this user. */
  receivesNotification: (n: NotificationSubject) => boolean;
  /** Highest report tier this user may open. */
  reportTier: () => ReportTier;
  canSeeReport: (tier: ReportTier) => boolean;
  canSeeCost: (key: CostKey) => boolean;
  propertySelector: () => SelectorScope;
  departmentSelector: () => SelectorScope;
  stationSelector: () => SelectorScope;
};

export type RecordSubject = {
  organizationId?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  stationId?: string | null;
  ownerUserId?: string | null;
  assignedUserId?: string | null;
  participantUserIds?: string[] | null;
};

export type NotificationSubject = {
  audience: "personal" | "assignment" | "station" | "department" | "property" | "organization";
  userId?: string | null;
  stationId?: string | null;
  departmentId?: string | null;
  branchId?: string | null;
};

const EMPTY_SET = new Set<string>();

function statusFor(facts: VisibilityFacts): WorkspaceStatus {
  if (!facts.userId || !facts.organizationId) return "no-account";
  const s = (facts.accountStatus ?? "").toLowerCase();
  if (s && s !== "active") return "suspended";
  if (!facts.setupComplete) return "setup-incomplete";
  if (facts.roleNames && !assignmentChainFor(facts).operationallyActive) return "setup-incomplete";
  return "ready";
}

/** The permanent assignment chain for the signed-in account. */
export function assignmentChainFor(facts: VisibilityFacts) {
  return resolveAssignmentChain({
    organizationId: facts.organizationId,
    branchIds: facts.branchIds,
    departmentIds: facts.departmentIds,
    stationIds: facts.stationIds,
    roleNames: facts.roleNames ?? [],
    reportingManagerId: facts.reportingManagerId ?? null,
  });
}


/**
 * The scope level is the backend access scope narrowed by real assignments:
 * a "department" account with only a station assigned sees a station, and an
 * account with no assignment at all never falls back to organisation-wide.
 */
export function scopeLevelFor(facts: VisibilityFacts): ScopeLevel {
  const declared = ACCESS_SCOPE_LEVEL[facts.accessScope ?? ""] ?? "personal";
  if (declared === "organization") return "organization";
  if (declared === "property") return facts.branchIds.length > 0 ? "property" : "personal";
  if (declared === "department") {
    if (facts.departmentIds.length > 0) return "department";
    if (facts.stationIds.length > 0) return "station";
    return "personal";
  }
  return facts.stationIds.length > 0 ? "station" : "personal";
}

/**
 * Builds the contract. Pure — the same inputs always produce the same
 * visibility, which is what makes the automated access matrix meaningful.
 */
export function resolveVisibility(facts: VisibilityFacts): VisibilityContract {
  const denials = facts.denials ?? EMPTY_SET;
  const status = statusFor(facts);
  const level = scopeLevelFor(facts);

  const entitled = (module: string) => {
    const value = facts.entitlements?.[module];
    return value === undefined ? true : Boolean(value);
  };

  const can = (module: string, featureOrAction: string, action?: string) => {
    if (status !== "ready") return false;
    const c = canonicalPermission(
      module,
      action === undefined ? featureOrAction : `${featureOrAction}.${action}`,
    );
    if (!entitled(c.module)) return false;
    if (denials.has(featureKey(c.module, c.feature, c.action))) return false;
    if (denials.has(featureKey(c.module, "*", c.action))) return false;
    return (
      facts.grants.has(featureKey(c.module, c.feature, c.action)) ||
      facts.grants.has(featureKey(c.module, "*", c.action)) ||
      facts.grants.has(featureKey(c.module, "*", `class:${actionClass(c.action)}`)) ||
      (action === undefined && facts.grants.has(permissionKey(c.module, c.action)))
    );
  };

  const isPlatformAdmin =
    can(PLATFORM_CAPABILITY.module, PLATFORM_CAPABILITY.feature, PLATFORM_CAPABILITY.action) &&
    (facts.accountType ?? "").toLowerCase() === "platform";

  const canSeePage = (path: string) => {
    if (status !== "ready") return false;
    return pathPermitted(can, path);
  };

  const canAct = (module: string, feature: string, action: string) => can(module, feature, action);

  const canDecide = (module: string, feature: string, requesterUserId?: string | null) => {
    if (requesterUserId && facts.userId && requesterUserId === facts.userId) return false;
    return can(module, feature, "approve");
  };

  const effectiveLevel = (module?: string, feature?: string): ScopeLevel => {
    if (!module) return level;
    // A capability may be held only for the user's own work even when their
    // account sits at a wider level, so the narrower of the two always wins.
    if (feature && can(module, feature, "view-all")) return level;
    return level;
  };

  const recordFilter = (module?: string, feature?: string): RecordFilter => ({
    level: effectiveLevel(module, feature),
    organizationId: facts.organizationId,
    branchIds: facts.branchIds,
    departmentIds: facts.departmentIds,
    stationIds: facts.stationIds,
    userIds: [facts.userId, ...(facts.subordinateUserIds ?? [])].filter(Boolean) as string[],
  });

  const canSeeRecord = (record: RecordSubject) => {
    if (status !== "ready") return false;
    if (record.organizationId && facts.organizationId && record.organizationId !== facts.organizationId)
      return false;

    const orgWide = level === "organization" || level === "platform";

    // Property is a hard boundary for everyone below organisation scope: a
    // department manager, a station worker and a line member of staff all stop
    // at the properties they are assigned to, whoever owns or is assigned the
    // record. This is checked before ownership so a record wrongly assigned
    // across properties still cannot be read.
    if (!orgWide && record.branchId && !facts.branchIds.includes(record.branchId)) return false;

    const mine =
      (record.ownerUserId && record.ownerUserId === facts.userId) ||
      (record.assignedUserId && record.assignedUserId === facts.userId) ||
      (record.participantUserIds ?? []).includes(facts.userId ?? "");
    if (mine) return true;
    const subordinate =
      (facts.subordinateUserIds ?? []).includes(record.ownerUserId ?? "") ||
      (facts.subordinateUserIds ?? []).includes(record.assignedUserId ?? "");

    switch (level) {
      case "platform":
      case "organization":
        return true;
      case "property":
        return Boolean(record.branchId && facts.branchIds.includes(record.branchId));
      case "department":
        // Department reach, still inside the assigned property.
        return (
          (Boolean(record.departmentId) && facts.departmentIds.includes(record.departmentId!)) ||
          (Boolean(record.stationId) && facts.stationIds.includes(record.stationId!)) ||
          subordinate
        );
      case "station":
        return (
          (Boolean(record.stationId) && facts.stationIds.includes(record.stationId!)) || subordinate
        );
      default:
        // Self scope: own work and the work of anyone who reports to them.
        // A peer's record is never visible, even in the same station.
        return subordinate;
    }
  };


  const taskFilter = () => recordFilter();

  const receivesNotification = (n: NotificationSubject) => {
    if (status !== "ready") return false;
    switch (n.audience) {
      case "personal":
        return n.userId === facts.userId;
      case "assignment":
        return (
          n.userId === facts.userId ||
          (Boolean(n.userId) && (facts.subordinateUserIds ?? []).includes(n.userId!))
        );
      case "station":
        return Boolean(n.stationId && facts.stationIds.includes(n.stationId));
      case "department":
        return Boolean(n.departmentId && facts.departmentIds.includes(n.departmentId));
      case "property":
        return Boolean(n.branchId && facts.branchIds.includes(n.branchId));
      case "organization":
        return level === "organization" || level === "platform";
      default:
        return false;
    }
  };

  const reportTier = (): ReportTier => {
    if (level === "platform" || level === "organization")
      return can("analytics", "overview", "view") ? "organization" : "personal";
    if (level === "property") return can("reports", "overview", "view") ? "property" : "personal";
    if (level === "department") return can("reports", "overview", "view") ? "department" : "personal";
    if (level === "station") return "station";
    return "personal";
  };

  const canSeeReport = (tier: ReportTier) =>
    REPORT_TIERS.indexOf(tier) <= REPORT_TIERS.indexOf(reportTier());

  const canSeeCost = (key: CostKey) => {
    const c = COST_CAPABILITIES[key];
    return can(c.module, c.feature, c.action);
  };

  const propertySelector = (): SelectorScope => ({
    allowAll: level === "organization" || level === "platform",
    ids: facts.branchIds,
    setupIncomplete: level !== "organization" && level !== "platform" && facts.branchIds.length === 0,
  });

  const departmentSelector = (): SelectorScope => ({
    allowAll: scopeRank(level) >= scopeRank("property"),
    ids: facts.departmentIds,
    setupIncomplete:
      scopeRank(level) < scopeRank("property") && facts.departmentIds.length === 0,
  });

  const stationSelector = (): SelectorScope => ({
    allowAll: scopeRank(level) >= scopeRank("department"),
    ids: facts.stationIds,
    setupIncomplete:
      scopeRank(level) < scopeRank("department") && facts.stationIds.length === 0,
  });

  return {
    facts,
    status,
    level,
    isPlatformAdmin,
    can,
    canSeePage,
    canAct,
    canDecide,
    recordFilter,
    canSeeRecord,
    taskFilter,
    receivesNotification,
    reportTier,
    canSeeReport,
    canSeeCost,
    propertySelector,
    departmentSelector,
    stationSelector,
  };
}

/** Applies a record filter to a Supabase query builder, narrowing never widening. */
export function applyRecordFilter<
  T extends {
    eq: (column: string, value: unknown) => T;
    in: (column: string, values: readonly unknown[]) => T;
  },
>(
  query: T,
  filter: RecordFilter,
  columns: {
    organization?: string;
    branch?: string;
    department?: string;
    station?: string;
    user?: string;
  },
): T {
  let q = query;
  if (columns.organization && filter.organizationId)
    q = q.eq(columns.organization, filter.organizationId);
  // Property first, for every level below organisation: department, station and
  // self scopes are all bounded by the assigned properties, so a department id
  // that also exists in another property can never widen the read.
  if (
    filter.level !== "organization" &&
    filter.level !== "platform" &&
    columns.branch &&
    filter.branchIds.length
  )
    q = q.in(columns.branch, filter.branchIds);
  switch (filter.level) {
    case "department":
      if (columns.department && filter.departmentIds.length)
        q = q.in(columns.department, filter.departmentIds);
      break;
    case "station":
      if (columns.station && filter.stationIds.length) q = q.in(columns.station, filter.stationIds);
      break;
    case "personal":
      if (columns.user && filter.userIds.length) q = q.in(columns.user, filter.userIds);
      break;
    default:
      break;
  }

  return q;
}
