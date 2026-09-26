/**
 * Permission engine vocabulary.
 *
 * A permission is a (module, action) pair. Roles hold sets of permissions and
 * users hold roles, so every access check in the UI resolves to `can(module, action)`.
 * The same pairs back the `public.has_permission()` function used by RLS policies.
 */

export const PERMISSION_MODULES = [
  "front-office",
  "restaurant",
  "bar",
  "kitchen",
  "housekeeping",
  "laundry",
  "procurement",
  "stores",
  "finance",
  "marketing",
  "events",
  "maintenance",
  "security-ops",
  "delivery",
  "human-resources",
  "administration",
  "reports",
  "analytics",
  "ai",
  "integrations",
  "migration",
  "quality",
  "support",
  "platform",
] as const;


export const PERMISSION_ACTIONS = [
  "view",
  "create",
  "edit",
  "delete",
  "approve",
  "reject",
  "export",
  "print",
  "override",
  "void",
  "refund",
] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export function titleize(value: string) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export const moduleLabels: Record<string, string> = Object.fromEntries(
  PERMISSION_MODULES.map((m) => [m, titleize(m)]),
);

export const actionLabels: Record<string, string> = Object.fromEntries(
  PERMISSION_ACTIONS.map((a) => [a, titleize(a)]),
);

export const permissionKey = (module: string, action: string) => `${module}:${action}`;

/**
 * Canonical `module.feature.action` key. `*` is the module-wide feature, so a
 * module-wide grant satisfies every feature check inside that module.
 */
export const featureKey = (module: string, feature: string, action: string) =>
  `${module}.${feature}.${action}`;


/** Sensitive actions that must always be permission-controlled and audited. */
export const SENSITIVE_ACTIONS: PermissionAction[] = [
  "void",
  "refund",
  "override",
  "delete",
  "approve",
];

/* ------------------------------------------------------------------ *
 * Canonical registry (mirrors public.permission_module_aliases and
 * public.permission_action_classes in the database, so the interface can
 * never offer an action the backend would refuse — or hide one it allows).
 * ------------------------------------------------------------------ */

export const MODULE_ALIASES: Record<string, string> = {
  pms: "front-office",
  pos: "restaurant",
  inventory: "stores",
  "crm-customers": "marketing",
  "crm-corporate": "marketing",
  "crm-loyalty": "marketing",
  "crm-segments": "marketing",
  "crm-feedback": "marketing",
  "crm-communications": "marketing",
  "crm-credit": "marketing",
  "crm-identity": "marketing",
  "crm-preferences": "marketing",
  "crm-ai": "marketing",
  "finance-ap": "finance",
  "finance-ar": "finance",
  "finance-gl": "finance",
  "finance-tax": "finance",
  "finance-payments": "finance",
  "finance-reports": "finance",
  "hr-employees": "human-resources",
  "hr-attendance": "human-resources",
  "hr-leave": "human-resources",
  "hr-payroll": "human-resources",
  "hr-performance": "human-resources",
  "hr-recruitment": "human-resources",
  "hr-scheduling": "human-resources",
  "hr-training": "human-resources",
  "hr-reports": "human-resources",
  "hr-announcements": "human-resources",
  users: "administration",
  roles: "administration",
  permissions: "administration",
  departments: "administration",
  stations: "administration",
  settings: "administration",
  security: "administration",
  audit_logs: "administration",
  automation: "integrations",
  "automation-ai": "integrations",
  "automation-providers": "integrations",
  kpis: "analytics",
  dashboards: "analytics",
  "executive-dashboard": "analytics",
  "ai-insights": "ai",
  alerts: "ai",
};

const VIEW_ACTIONS = [
  "view", "availability", "readiness", "report", "eta", "access", "beo",
];
/**
 * Sensitive reads deliberately excluded from the view class (mirrors the rows
 * removed from `public.permission_action_classes`): financials, revenue, cost,
 * view_costs, view_profit, view_compliance, view-all, view-own, performance,
 * rider-location. A generic view grant must never imply money, cost or
 * whole-department visibility, and an own-records grant must never imply
 * everyone else's records.
 */

const CREATE_ACTIONS = [
  "create", "create-assisted", "perform", "record", "request", "apply", "clock", "issue",
  "send", "submit", "start", "schedule", "quote", "conduct", "attempt", "count_cash", "open",
  "open_shift", "pickup", "deliver", "collect", "contact", "contact-customer", "contact-rider",
  "proof", "generate", "prepare", "ready", "receive", "split", "hold", "accept", "cash",
  "cod", "partial",
];
const EDIT_ACTIONS = [
  "edit", "edit_draft", "update", "manage", "manage-defaults", "assign", "reassign", "adjust",
  "block", "cancel", "cancel_item", "cancel_request", "mark_no_show", "customize", "configure",
  "prioritize", "release", "reinstate", "upgrade", "correct", "close", "close_shift", "convert",
  "post_charge", "inspect", "review", "process", "complete", "transfer",
];

/**
 * Detailed actions covered by a module-wide grant. Sensitive actions
 * (approve, reject, void, refund, override, delete, reverse, write-off,
 * period close, payroll, termination) are intentionally absent — they must
 * always be granted explicitly.
 */
export const ACTION_CLASSES: Record<string, string> = {
  ...Object.fromEntries(VIEW_ACTIONS.map((a) => [a, "view"])),
  ...Object.fromEntries(CREATE_ACTIONS.map((a) => [a, "create"])),
  ...Object.fromEntries(EDIT_ACTIONS.map((a) => [a, "edit"])),
  print: "print",
  reprint: "print",
  export: "export",
};

export const actionClass = (action: string) => ACTION_CLASSES[action] ?? action;

/**
 * Historical sub-module keys are really features of a parent module. Mapping
 * them onto the canonical feature (rather than the module wildcard) is what
 * makes a grant such as CRM → Customers stop implying every other CRM screen.
 */
export const ALIAS_FEATURES: Record<string, string> = {
  "crm-customers": "customers",
  "crm-corporate": "corporate",
  "crm-loyalty": "loyalty",
  "crm-segments": "segments",
  "crm-feedback": "feedback",
  "crm-communications": "communications",
  "crm-credit": "credit",
  "crm-identity": "identity",
  "crm-preferences": "preferences",
  "crm-ai": "ai",
  "finance-ap": "ap",
  "finance-ar": "ar",
  "finance-gl": "gl",
  "finance-tax": "tax",
  "finance-payments": "payments",
  "finance-reports": "reports",
  "hr-employees": "employees",
  "hr-attendance": "attendance",
  "hr-leave": "leave",
  "hr-payroll": "payroll",
  "hr-performance": "performance",
  "hr-recruitment": "recruitment",
  "hr-scheduling": "scheduling",
  "hr-training": "training",
  "hr-reports": "reports",
  "hr-announcements": "announcements",
  users: "users",
  roles: "roles",
  permissions: "permissions",
  departments: "departments",
  stations: "stations",
  settings: "settings",
  security: "security",
  audit_logs: "audit-logs",
  automation: "automation",
  "automation-ai": "automation-ai",
  "automation-providers": "providers",
  kpis: "kpis",
  dashboards: "dashboards",
  "executive-dashboard": "executive",
  "ai-insights": "insights",
  alerts: "alerts",
};


/**
 * Whole-key aliases: historical `module.action` capability names that resolve
 * onto a different canonical `module.feature.action` triple. Mirrors
 * `public.permission_key_aliases`, so a screen asking for a legacy key gets the
 * same answer the database gives an RLS policy.
 */
export const KEY_ALIASES: Record<string, { module: string; feature: string; action: string }> = {
  "administration|approve": { module: "administration", feature: "approvals", action: "decide" },
  "administration|approvals": { module: "administration", feature: "approvals", action: "view" },
  "administration|approvals.decide": { module: "administration", feature: "approvals", action: "decide" },
  "administration|approvals.emergency_override": { module: "administration", feature: "*", action: "override" },

  "administration|audit": { module: "administration", feature: "audit-logs", action: "view" },
  "administration|users": { module: "administration", feature: "users", action: "view" },
  "administration|workspace": { module: "administration", feature: "*", action: "edit" },
  "events|billing": { module: "events", feature: "billing", action: "view" },
  "events|bookings": { module: "events", feature: "bookings", action: "view" },
  "events|enquiries": { module: "events", feature: "enquiries", action: "view" },
  "events|feedback": { module: "events", feature: "feedback", action: "view" },
  "events|quotations": { module: "events", feature: "quotations", action: "view" },
  "events|reports": { module: "events", feature: "reports", action: "view" },
  "events|resources": { module: "events", feature: "resources", action: "view" },
  "finance-payments|close_shift": { module: "restaurant", feature: "shifts", action: "edit" },
  "finance-payments|count_cash": { module: "restaurant", feature: "shifts", action: "edit" },
  "finance-payments|open_shift": { module: "restaurant", feature: "shifts", action: "create" },
  "finance-payments|receive_payment": { module: "front-office", feature: "folios", action: "create" },
  "finance|cash.review": { module: "finance", feature: "banking", action: "edit" },
  "finance|folios.reopen": { module: "finance", feature: "*", action: "approve" },
  "housekeeping|inspections": { module: "housekeeping", feature: "*", action: "inspect" },
  "housekeeping|tasks": { module: "housekeeping", feature: "tasks", action: "edit" },
  "inventory|adjustments.approve": { module: "stores", feature: "*", action: "approve" },
  "inventory|stock.manage": { module: "stores", feature: "*", action: "edit" },
  "inventory|stocktake.manage": { module: "stores", feature: "*", action: "edit" },
  "inventory|transfers.manage": { module: "stores", feature: "*", action: "edit" },
  "kitchen|queue.manage": { module: "kitchen", feature: "queue", action: "edit" },
  "operations|view": { module: "tasks", feature: "*", action: "view" },
  "pms|checkin.perform": { module: "front-office", feature: "arrivals", action: "edit" },
  "pms|checkin.revert": { module: "front-office", feature: "*", action: "approve" },
  "pms|checkout.perform": { module: "front-office", feature: "departures", action: "edit" },
  "pms|dashboard.view": { module: "front-office", feature: "overview", action: "view" },
  "pms|folios.post_charge": { module: "front-office", feature: "folios", action: "create" },
  "pms|folios.reopen": { module: "front-office", feature: "folios", action: "approve" },
  "pms|folios.transfer": { module: "front-office", feature: "folios", action: "edit" },
  "pms|payments.record": { module: "front-office", feature: "folios", action: "create" },
  "pms|reservations.manage": { module: "front-office", feature: "reservations", action: "edit" },
  "pms|rooms.assign": { module: "front-office", feature: "arrivals", action: "edit" },
  "pms|rooms.manage": { module: "front-office", feature: "rack", action: "edit" },
  "pms|rooms.transfer": { module: "front-office", feature: "in-house", action: "edit" },
  "pms|rooms.view": { module: "front-office", feature: "rack", action: "view" },
  "pms|write": { module: "front-office", feature: "*", action: "edit" },
  // `pos.approvals.decide` is the spoken name of the POS decision authority.
  // It is an alias, not a new grant: it resolves onto the catalogued
  // `restaurant.approvals.approve` so screen, route, RPC and RLS all answer
  // from one permission instead of drifting into a phantom capability.
  "pos|approvals.decide": { module: "restaurant", feature: "approvals", action: "approve" },
  "restaurant|approvals.decide": { module: "restaurant", feature: "approvals", action: "approve" },
  "pos|menu": { module: "restaurant", feature: "menu", action: "edit" },

  "pos|payments": { module: "restaurant", feature: "orders", action: "edit" },
  "pos|room_charge.post": { module: "restaurant", feature: "orders", action: "approve" },
  "pos|shifts.open": { module: "restaurant", feature: "shifts", action: "create" },
  "pos|shifts.review": { module: "restaurant", feature: "shifts", action: "edit" },
  "pos|write": { module: "restaurant", feature: "*", action: "edit" },
  "restaurant|menu": { module: "restaurant", feature: "menu", action: "edit" },
  "restaurant|orders.manage": { module: "restaurant", feature: "orders", action: "edit" },
};

/** Normalises any historical key shape into `module.feature.action`. */
export function canonicalPermission(
  module: string,
  actionOrFeature: string,
  action?: string,
): { module: string; feature: string; action: string } {
  // Whole-key aliases only apply to the two-part shape, exactly as the
  // database resolver requires `_feature = '*'`.
  if (action === undefined) {
    const aliased = KEY_ALIASES[`${module}|${actionOrFeature}`];
    if (aliased) return { ...aliased };
  }
  const canonicalModule = MODULE_ALIASES[module] ?? module;
  const raw = action === undefined ? actionOrFeature : `${actionOrFeature}.${action}`;
  const dot = raw.indexOf(".");
  const explicitFeature = dot > 0 ? raw.slice(0, dot) : null;
  const finalAction = dot > 0 ? raw.slice(dot + 1) : raw;
  const feature = explicitFeature ?? ALIAS_FEATURES[module] ?? "*";
  return { module: canonicalModule, feature, action: finalAction };
}


/**
 * Expands one held grant into every key shape a screen may ask for.
 *
 * Feature-level grants are deliberately NOT expanded into the legacy
 * `module:action` key. That fallback used to make one feature grant satisfy a
 * bare `module:action` check, so `administration.users.view` silently unlocked
 * Departments, Stations, Settings and every other Administration feature. The
 * legacy key is now written only by genuinely module-wide grants
 * (`module.*.action`), where satisfying every feature of the module is the
 * literal meaning of the grant. Everything else is deny-by-default at feature
 * level, exactly as `public.has_exact_permission()` resolves it.
 *
 * Shared deliberately: the signed-in session, Role Testing and Workspace
 * Preview must all expand grants identically, otherwise a preview can show
 * access a real login refuses (or hide access it allows).
 */
export function addGrant(
  set: Set<string>,
  module: string,
  feature: string | null,
  action: string,
) {
  const c = canonicalPermission(
    module,
    feature && feature !== "*" ? `${feature}.${action}` : action,
  );
  set.add(featureKey(c.module, c.feature, c.action));
  // The database matches on the action class as well as the literal action, for
  // feature-scoped grants and module-wide grants alike.
  set.add(featureKey(c.module, c.feature, `class:${actionClass(c.action)}`));
  if (c.feature === "*") {
    // Module-wide authority — and only module-wide authority — keeps the legacy
    // `module:action` shape alive for callers that still ask the two-part way.
    set.add(permissionKey(c.module, c.action));
    set.add(featureKey(c.module, "*", `class:${actionClass(c.action)}`));
  }
}



/**
 * The single capability answer.
 *
 * The signed-in session, Role Testing and Workspace Preview all resolve access
 * through this one function, so a preview can never show a page a real login
 * refuses — or hide one it allows.
 */
export function canFromPermissions(permissions: Set<string>) {
  return (module: string, actionOrFeature: string, action?: string) => {
    const c = canonicalPermission(module, actionOrFeature, action);
    const canonicalModule = MODULE_ALIASES[module] ?? module;
    // Some catalogued grants are module-wide with a dotted action
    // (`delivery.*.dispatch.assign`). `canonicalPermission` reads the first
    // segment as a feature, so the whole dotted string is checked too.
    const rawAction = action === undefined ? actionOrFeature : `${actionOrFeature}.${action}`;
    return (
      permissions.has(featureKey(c.module, c.feature, c.action)) ||
      permissions.has(featureKey(c.module, "*", c.action)) ||
      permissions.has(permissionKey(c.module, c.action)) ||
      permissions.has(featureKey(canonicalModule, "*", rawAction)) ||
      permissions.has(permissionKey(canonicalModule, rawAction)) ||
      permissions.has(featureKey(c.module, c.feature, `class:${actionClass(c.action)}`)) ||
      permissions.has(featureKey(c.module, "*", `class:${actionClass(c.action)}`))
    );
  };
}

/**
 * The strict answer, mirroring `public.has_exact_permission()`.
 *
 * `canFromPermissions` also matches by action class, which is right for
 * ordinary CRUD surfaces but wrong for authorities that must be granted
 * deliberately: a chef's module-wide `kitchen.edit` should never resolve
 * `kitchen.chef.assign`. Ask this way whenever the backend gate is exact.
 */
export function canExactlyFromPermissions(permissions: Set<string>) {
  return (module: string, actionOrFeature: string, action?: string) => {
    const c = canonicalPermission(module, actionOrFeature, action);
    const canonicalModule = MODULE_ALIASES[module] ?? module;
    const rawAction = action === undefined ? actionOrFeature : `${actionOrFeature}.${action}`;
    return (
      permissions.has(featureKey(c.module, c.feature, c.action)) ||
      permissions.has(featureKey(c.module, "*", c.action)) ||
      permissions.has(permissionKey(c.module, c.action)) ||
      permissions.has(featureKey(canonicalModule, "*", rawAction)) ||
      permissions.has(permissionKey(canonicalModule, rawAction))
    );
  };
}


/**
 * Module-level entry: may this session open ANY surface of a module?
 *
 * A workspace landing page is not a feature of its own — it is the module's
 * front door. A Rider holding `delivery.my-work.view` and a Maintenance
 * Officer holding `maintenance.overview.view` must reach their workspace, so
 * asking for a module-wide `delivery.*.view` grant (which no operational role
 * template carries) locked them out of the very work they were notified about.
 *
 * This asks the honest question instead: does the role hold this action — or
 * an equivalent action class — on any feature of the module? It never grants
 * a feature the role lacks; each inner screen still asks its own capability.
 */
export function canModuleFromPermissions(permissions: Set<string>) {
  const can = canFromPermissions(permissions);
  return (module: string, action = "view") => {
    if (can(module, action)) return true;
    const canonicalModule = MODULE_ALIASES[module] ?? module;
    const cls = `class:${actionClass(action)}`;
    for (const key of permissions) {
      const parts = key.split(".");
      if (parts.length < 3) continue;
      if (parts[0] !== module && parts[0] !== canonicalModule) continue;
      const grantedAction = parts.slice(2).join(".");
      if (grantedAction === action || grantedAction === cls) return true;
    }
    return false;
  };
}
