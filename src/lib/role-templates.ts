/**
 * Compiled role catalogue — feature-level capability templates.
 *
 * This mirrors `public.role_feature_templates`, which the database migration
 * seeds and `public.neo_apply_feature_templates()` compiles into real
 * `role_permissions` rows. Keeping an identical copy in TypeScript lets the
 * automated role-access matrix prove, offline and on every commit, that what
 * the sidebar shows a role is exactly what its grants allow — and that no
 * template grants a capability no route or control actually uses.
 *
 * A template entry is `module.feature`. The actions a role receives on those
 * features come from its access scope, never from its name:
 *
 *   organisation → view create edit delete approve reject export print
 *                  override void refund   (full authority)
 *   branch/department (a lead) → view create edit approve export print
 *   team → view create edit export
 *   self/technical (a line role) → view create edit
 */

export type RoleAccessScope =
  | "organisation"
  | "branch"
  | "department"
  | "team"
  | "self"
  | "technical";

const ORGANISATION_ACTIONS = [
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
];
const LEAD_ACTIONS = ["view", "create", "edit", "approve", "export", "print"];
const TEAM_ACTIONS = ["view", "create", "edit", "export"];
const LINE_ACTIONS = ["view", "create", "edit"];

export function actionsForScope(scope: RoleAccessScope): string[] {
  if (scope === "organisation") return ORGANISATION_ACTIONS;
  if (scope === "branch" || scope === "department") return LEAD_ACTIONS;
  if (scope === "team") return TEAM_ACTIONS;
  return LINE_ACTIONS;
}

/** `module.feature` entries; `module.*` means every feature of that module. */
export const ROLE_FEATURE_TEMPLATES: Record<string, string[]> = {
  owner: [
    "front-office.*",
    "restaurant.*",
    "bar.*",
    "kitchen.*",
    "housekeeping.*",
    "laundry.*",
    "maintenance.*",
    "security-ops.*",
    "stores.*",
    "procurement.*",
    "finance.*",
    "marketing.*",
    "events.*",
    "delivery.*",
    "human-resources.*",
    "administration.*",
    "integrations.*",
    "platform.*",
    "migration.*",
    "quality.*",
    "support.*",
    "analytics.*",
    "reports.*",
    "ai.*",
  ],
  // Operations Manager runs the property's operation; they are not a second
  // Owner. Oversight of every operational department, the reports that explain
  // it, the escalations and wastage that need a decision, and the approval
  // inbox — and nothing else. Financial posting, the cash queue, master-data
  // mutation, HR administration, CRM settings, procurement execution and
  // system configuration are deliberately absent; where the organisation wants
  // one of them, it is delegated explicitly, never inherited from the title.
  "operations-manager": [
    "front-office.*",
    "restaurant.*",
    "bar.*",
    "kitchen.*",
    "housekeeping.*",
    "laundry.*",
    "maintenance.*",
    "security-ops.*",
    "stores.*",
    "events.*",
    "delivery.*",
    "analytics.*",
    "reports.*",
    "ai.insights",
    // Read-only sight of what purchasing is doing. Raising, approving or
    // receiving an order is procurement's execution authority, not oversight.
    "procurement.overview",
  ],
  "finance-manager": [
    "finance.*",
    "front-office.folios",
    "restaurant.reports",
    "procurement.overview",
    "procurement.lpos",
    "events.billing",
    "marketing.crm-corporate",
    "analytics.overview",
    "analytics.catalogue",
    "reports.overview",
  ],
  // An Accountant must be able to actually account: accounts payable, the
  // general ledger and its chart of accounts, journals and reconciliation are
  // routine bookkeeping, not Finance Manager privileges. What they must NOT
  // hold — payment approval, period close, accounting configuration — is
  // withheld by action authority below, not by hiding the workspace.
  accountant: [
    "finance.dashboard",
    "finance.eod",
    "finance.sessions",
    "finance.gl",
    "finance.journals",
    "finance.ap",
    "finance.reconciliation",
    "finance.period",
    "finance.receivables",
    "finance.banking",
    "finance.tax",
    "front-office.folios",
    "restaurant.reports",
    "reports.overview",
  ],

  // Food & Beverage — the department owns restaurant service, the coffee
  // station and its own requisitions and wastage. It never settles payments
  // (that is the Cashier) and never moves Stores balances itself.
  "food-and-beverage-manager": [
    "restaurant.overview",
    "restaurant.floor",
    "restaurant.orders",
    "restaurant.kds",
    "restaurant.menu",
    "restaurant.shifts",
    "restaurant.reports",
    "restaurant.approvals",
    "restaurant.requisitions",
    "restaurant.wastage",
    "restaurant.complimentary",
    "kitchen.overview",
    "kitchen.queue",
    "kitchen.reports",
    "stores.overview",
    "events.overview",
    "analytics.overview",
    "analytics.catalogue",
    "reports.overview",
    "ai.insights",
  ],
  waiter: [
    "restaurant.overview",
    "restaurant.floor",
    "restaurant.orders",
    "restaurant.kds",
    "restaurant.shifts",
    "restaurant.wastage",
  ],
  barista: [
    "restaurant.overview",
    "restaurant.floor",
    "restaurant.orders",
    "restaurant.kds",
    "restaurant.shifts",
    "restaurant.wastage",
  ],
  "bar-attendant": [
    "bar.overview",
    "bar.queue",
    "bar.pos",
    "bar.requisitions",
    "bar.wastage",
    "restaurant.overview",
    "restaurant.orders",
    "restaurant.shifts",
  ],
  "head-chef": [
    // Staff Board — read-only, and narrowed to this department by access scope.
    "reports.overview",
    "kitchen.*",
    "restaurant.kds",
    "restaurant.menu",
    "stores.overview",
    "procurement.overview",
  ],
  // A chef sees the items assigned to them and can flag a shortage — never the
  // wider queue's money, never a requisition.
  "hot-kitchen-chef": [
    "kitchen.overview",
    "kitchen.my-station",
    "kitchen.production",
    "kitchen.recipes",
    "kitchen.needs",
    "kitchen.waste",
  ],
  "chief-steward": [
    "kitchen.overview",
    "kitchen.stewarding",
    "kitchen.stores",
    "kitchen.waste",
    "kitchen.quality",
    "stores.overview",
  ],
  // A steward's world is their own cleaning tasks, the checklists and breakages.
  "kitchen-steward": ["kitchen.overview", "kitchen.stewarding"],
  // The Head Pastry Chef owns the bakery plan, custom cakes and wastage review,
  // and is the only pastry role that may raise a Stores requisition.
  "head-pastry-chef": [
    // Staff Board — read-only, and narrowed to this department by access scope.
    "reports.overview",
    "kitchen.overview",
    "kitchen.my-station",
    "kitchen.production",
    "kitchen.recipes",
    "kitchen.queue",
    "kitchen.quality",
    "kitchen.waste",
    "kitchen.needs",
    "kitchen.reports",
    "kitchen.pastry-schedule",
    "kitchen.pastry-production",
    "kitchen.pastry-custom-orders",
    "kitchen.pastry-waste",
    "kitchen.pastry-needs",
    "kitchen.pastry-requisition",
  ],
  // A Pastry Chef sees only their own production; no schedule, no cake pricing,
  // no requisition.
  "pastry-chef": [
    "kitchen.overview",
    "kitchen.my-station",
    "kitchen.production",
    "kitchen.recipes",
    "kitchen.needs",
    "kitchen.pastry-production",
    "kitchen.pastry-waste",
    "kitchen.pastry-needs",
  ],
  "front-office-supervisor": ["front-office.*", "marketing.crm-customers", "housekeeping.board"],
  "front-office-manager": [
    "front-office.*",
    "marketing.crm-customers",
    "housekeeping.board",
    // Staff Board — read-only, and narrowed to this department by access scope.
    "reports.overview",
  ],
  // The supervisor coordinates production and consolidates needs, but the Head
  // Chef alone raises the requisition.
  "hot-kitchen-supervisor": [
    "kitchen.overview",
    "kitchen.queue",
    "kitchen.my-station",
    "kitchen.stewarding",
    "kitchen.production",
    "kitchen.recipes",
    "kitchen.needs",
    "kitchen.waste",
    "restaurant.kds",
  ],

  // The coffee counter, not the restaurant. No floor plan, no menu authoring
  // and no restaurant-wide shift administration.
  "coffee-station-supervisor": [
    "restaurant.overview",
    "restaurant.orders",
    "restaurant.kds",
    "restaurant.shifts",
    "restaurant.reports",
    "restaurant.requisitions",
    "restaurant.wastage",
    "stores.overview",
    "ai.insights",
  ],
  "restaurant-manager": [
    // Staff Board — read-only, and narrowed to this department by access scope.
    "reports.overview",
    "restaurant.overview",
    "restaurant.floor",
    "restaurant.orders",
    "restaurant.kds",
    "restaurant.menu",
    "restaurant.shifts",
    "restaurant.reports",
    "restaurant.approvals",
    "restaurant.requisitions",
    "restaurant.wastage",
    "restaurant.complimentary",
    "kitchen.overview",
    "kitchen.queue",
    "stores.overview",
    "marketing.crm-customers",
    "ai.insights",
  ],
  "bar-manager": [
    // Staff Board — read-only, and narrowed to this department by access scope.
    "reports.overview",
    "bar.*",
    "restaurant.overview",
    "restaurant.orders",
    "restaurant.shifts",
    "restaurant.reports",
    "stores.overview",
    "ai.insights",
  ],
  // The cashier is the counting party for every kind of cash that reaches the
  // till, including cash a rider collected on delivery. That hand-in is counted
  // on the till screen itself, so no delivery/dispatch surface is opened here.
  cashier: [
    "front-office.overview",
    "front-office.folios",
    "front-office.departures",
    "restaurant.shifts",
    "finance.collections",
    "finance.till",
    "finance.sessions",
  ],
  // Social content, the publishing calendar and social enquiries only. Budget,
  // campaign approval, promotions, consent and settings stay with the
  // Marketing Manager, and supply needs travel upward rather than becoming a
  // Stores requisition raised here.
  "social-media-manager": [
    "marketing.overview",
    "marketing.content",
    "marketing.calendar",
    "marketing.campaigns",
    "marketing.leads",
    "marketing.reviews",
    "marketing.feedback",
    "marketing.tasks",
    "marketing.stock_needs",
    "marketing.crm-customers",
    "analytics.overview",
    "analytics.catalogue",
    "reports.overview",
  ],
  receptionist: [
    "front-office.overview",
    "front-office.arrivals",
    "front-office.departures",
    "front-office.in-house",
    "front-office.reservations",
    "front-office.availability",
    "front-office.rack",
    "front-office.folios",
    "front-office.requests",
    "front-office.guests",
    "front-office.tasks",
    "front-office.stock_needs",
    "marketing.crm-customers",
  ],
  "reservations-agent": [
    "front-office.reservations",
    "front-office.availability",
    "front-office.waitlist",
    "front-office.groups",
    "front-office.guests",
    "front-office.rates",
  ],
  "front-office-cashier": [
    "front-office.overview",
    "front-office.folios",
    "front-office.departures",
    "restaurant.shifts",
  ],
  porter: ["front-office.arrivals", "front-office.in-house", "front-office.requests"],
  driver: ["front-office.requests", "delivery.overview"],
  "housekeeping-supervisor": [
    "housekeeping.*",
    "laundry.batches",
    "front-office.rack",
    "maintenance.overview",
  ],
  "housekeeping-manager": [
    // Staff Board — read-only, and narrowed to this department by access scope.
    "reports.overview",
    "housekeeping.*",
    "laundry.batches",
    "front-office.rack",
    "maintenance.overview",
  ],
  "laundry-manager": [
    "laundry.*",
    "housekeeping.overview",
    "front-office.rack",
    "maintenance.overview",
    // Staff Board — read-only, and narrowed to this department by access scope.
    "reports.overview",
  ],
  "maintenance-officer": [
    "maintenance.overview",
    "maintenance.my-jobs",
    "maintenance.grounds",
    "maintenance.supplies",
  ],
  housekeeper: [
    "housekeeping.my-work",
    // Executing the clean assigned to them: start and finish. Assignment,
    // inspection and release stay with the supervisor.
    "housekeeping.cleaning",
    "housekeeping.supplies",
  ],
  "laundry-supervisor": [
    "laundry.guest",
    "laundry.batches",
    "laundry.my-work",
    "laundry.incidents",
    "laundry.supplies",
    "housekeeping.overview",
    "front-office.rack",
  ],
  "laundry-attendant": ["laundry.my-work", "laundry.supplies"],
  "maintenance-manager": [
    // Staff Board — read-only, and narrowed to this department by access scope.
    "reports.overview",
    "maintenance.*",
    "housekeeping.board",
    "front-office.rack",
    "stores.overview",
    "procurement.overview",
  ],
  "maintenance-technician": [
    "maintenance.overview",
    "maintenance.my-jobs",
    "maintenance.grounds",
    "maintenance.supplies",
  ],
  "grounds-worker": ["maintenance.my-tasks", "maintenance.supplies"],
  "marketing-manager": [
    "marketing.*",
    "events.overview",
    "analytics.overview",
    "analytics.catalogue",
    "reports.overview",
  ],
  "sales-and-events-manager": [
    // Staff Board — read-only, and narrowed to this department by access scope.
    "reports.overview",
    "events.*",
    "marketing.crm-corporate",
    "marketing.leads",
    "front-office.availability",
  ],
  "events-coordinator": [
    "events.overview",
    "events.enquiries",
    "events.quotations",
    "events.bookings",
    "events.calendar",
    "events.site-visits",
    "events.readiness",
    "events.resources",
    "events.venues",
    "events.banqueting",
    "events.my_tasks",
    "events.stock_needs",
  ],
  // Banqueting staff execute the events they are assigned to: their own task
  // console, the setup they were briefed on and a way to flag missing items.
  // No pricing, no payments, no cancellations, no Stores requisitions.
  "banqueting-staff": [
    "events.overview",
    "events.calendar",
    "events.my_tasks",
    "events.stock_needs",
  ],
  // Purchasing authority and stock custody are deliberately separate: a buyer
  // never receives goods, and a store keeper never approves the order.
  "procurement-manager": [
    // Staff Board — read-only, and narrowed to this department by access scope.
    "reports.overview",
    "procurement.overview",
    "procurement.requests",
    "procurement.orders",
    "procurement.quotations",
    "procurement.lpos",
    "procurement.suppliers",
    "stores.overview",
    "stores.items",
    "stores.reconciliation",
    "finance.ap",
  ],
  "procurement-officer": [
    "procurement.overview",
    "procurement.requests",
    "procurement.orders",
    "procurement.quotations",
    "procurement.lpos",
    "procurement.suppliers",
  ],
  // Custody of stock. Receiving goods against an order is store work; the
  // Procurement workspace itself is not.
  storekeeper: [
    "stores.overview",
    "stores.items",
    "stores.issues",
    "stores.reconciliation",
    "procurement.receiving",
    "kitchen.stores",
  ],
  "receiving-clerk": ["stores.overview", "procurement.receiving"],
  "human-resources-manager": [
    // Staff Board — read-only, and narrowed to this department by access scope.
    "reports.overview",
    "human-resources.*",
    "administration.users",
    "administration.departments",
  ],
  "hr-officer": [
    "human-resources.overview",
    "human-resources.employees",
    "human-resources.attendance",
    "human-resources.leave",
    "human-resources.recruitment",
    "human-resources.training",
    "human-resources.scheduling",
    "human-resources.documents",
    "human-resources.stock_needs",
  ],
  "security-supervisor": [
    "security-ops.*",
    "front-office.in-house",
    "administration.audit-logs",
    "maintenance.overview",
    "housekeeping.board",
  ],
  "security-guard": [
    "security-ops.overview",
    "security-ops.my-post",
    "security-ops.incidents",
    "security-ops.patrols",
    "security-ops.visitors",
    "security-ops.handovers",
    "security-ops.stock-needs",
  ],
  // IT/System Administrator is a superuser alongside Owner/Director: the
  // product administration team needs full inspection, configuration,
  // troubleshooting and operational-check access to every module. Commercial
  // approval authority is a separate governance capability — restricted
  // actions (discount, void, complimentary, refund, reversal) are stripped
  // from this template and only granted when the organisation's approval
  // matrix names System Administration as an approver.
  "it-system-administrator": [
    "front-office.*",
    "restaurant.*",
    "bar.*",
    "kitchen.*",
    "housekeeping.*",
    "laundry.*",
    "maintenance.*",
    "security-ops.*",
    "stores.*",
    "procurement.*",
    "finance.*",
    "marketing.*",
    "events.*",
    "delivery.*",
    "human-resources.*",
    "administration.*",
    "integrations.*",
    "platform.*",
    "migration.*",
    "quality.*",
    "support.*",
    "analytics.*",
    "reports.*",
    "ai.*",
  ],
  "delivery-manager": [
    // Staff Board — read-only, and narrowed to this department by access scope.
    "reports.overview",
    "delivery.*",
    "restaurant.orders",
    "marketing.crm-customers",
  ],
  rider: ["delivery.overview", "delivery.my-work"],
};

/** Access scope per catalogue role — mirrors `public.role_catalogue`. */
export const ROLE_ACCESS_SCOPES: Record<string, RoleAccessScope> = {
  owner: "organisation",
  cashier: "self",
  "restaurant-manager": "department",
  "bar-manager": "department",
  "coffee-station-supervisor": "team",
  "front-office-manager": "department",
  "housekeeping-manager": "department",
  "laundry-manager": "department",
  "hot-kitchen-supervisor": "team",
  "maintenance-officer": "team",
  "social-media-manager": "team",
  "operations-manager": "branch",
  "finance-manager": "department",
  accountant: "team",
  "food-and-beverage-manager": "department",
  waiter: "self",
  barista: "self",
  "bar-attendant": "self",
  "head-chef": "department",
  "hot-kitchen-chef": "self",
  "chief-steward": "team",
  "kitchen-steward": "self",
  "head-pastry-chef": "department",
  "pastry-chef": "self",
  "front-office-supervisor": "department",
  receptionist: "self",
  "reservations-agent": "self",
  "front-office-cashier": "self",
  porter: "self",
  driver: "self",
  "housekeeping-supervisor": "department",
  housekeeper: "self",
  "laundry-supervisor": "team",
  "laundry-attendant": "self",
  "maintenance-manager": "department",
  "maintenance-technician": "self",
  "grounds-worker": "self",
  "marketing-manager": "branch",
  "sales-and-events-manager": "department",
  "events-coordinator": "team",
  "banqueting-staff": "self",
  "procurement-manager": "department",
  "procurement-officer": "team",
  storekeeper: "department",
  "receiving-clerk": "self",
  "human-resources-manager": "department",
  "hr-officer": "team",
  "security-supervisor": "department",
  "security-guard": "self",
  "it-system-administrator": "technical",
  "delivery-manager": "department",
  rider: "self",
};

export type CompiledGrant = { module: string; feature: string; action: string };

/**
 * Approved least-privilege templates for the nine catalogue gaps. These are
 * explicit grants rather than scope-generated module access, so ordinary
 * supervisory work cannot accidentally acquire refund, void, override,
 * complimentary, reversal or reopen authority.
 */
export const ROLE_EXACT_GRANTS: Record<string, CompiledGrant[]> = {
  "bar-manager": [
    ["ai", "insights", "view"], ["bar", "overview", "view"], ["bar", "overview", "create"], ["bar", "overview", "edit"], ["bar", "overview", "export"], ["bar", "overview", "print"],
    ["bar", "queue", "view"], ["bar", "queue", "create"], ["bar", "queue", "edit"], ["bar", "pos", "view"], ["bar", "pos", "create"], ["bar", "pos", "edit"],
    ["bar", "orders", "view"], ["bar", "orders", "create"], ["bar", "orders", "edit"], ["bar", "orders", "export"], ["bar", "orders", "print"],
    ["bar", "requisitions", "view"], ["bar", "requisitions", "create"], ["bar", "requisitions", "edit"], ["bar", "requisitions", "approve"], ["bar", "requisitions", "export"], ["bar", "requisitions", "print"],
    ["bar", "stock", "view"], ["bar", "stock", "create"], ["bar", "stock", "edit"], ["bar", "stock", "export"], ["bar", "stock", "print"],
    ["bar", "wastage", "view"], ["bar", "wastage", "create"], ["bar", "wastage", "edit"], ["bar", "wastage", "approve"], ["bar", "wastage", "export"], ["bar", "wastage", "print"],
    ["bar", "reports", "view"], ["bar", "reports", "export"], ["bar", "reports", "print"],
    ["restaurant", "overview", "view"], ["restaurant", "orders", "view"], ["restaurant", "shifts", "view"], ["restaurant", "reports", "view"], ["restaurant", "reports", "export"],
    ["stores", "overview", "view"], ["reports", "overview", "view"], ["reports", "overview", "export"], ["reports", "overview", "print"],
  ].map(([module, feature, action]) => ({ module: module!, feature: feature!, action: action! })),
  cashier: [
    ["ai", "insights", "view"], ["finance", "collections", "view"], ["finance", "collections", "collect_payment"], ["finance", "collections", "issue_receipt"], ["finance", "collections", "query_bill"], ["finance", "collections", "reprint_receipt"], ["finance", "collections", "settle_bill"], ["finance", "collections", "verify_bill"],
    ["finance", "till", "view"], ["finance", "till", "create"], ["finance", "till", "edit"], ["finance", "till", "close"], ["finance", "till", "confirm_cash"], ["finance", "till", "declare_cash"],
    ["finance", "sessions", "view"], ["finance", "sessions", "create"], ["finance", "sessions", "edit"], ["front-office", "overview", "view"], ["front-office", "folios", "view"], ["front-office", "departures", "view"], ["restaurant", "shifts", "view"],
  ].map(([module, feature, action]) => ({ module: module!, feature: feature!, action: action! })),
  "coffee-station-supervisor": [
    ["ai", "insights", "view"], ["restaurant", "overview", "view"], ["restaurant", "orders", "view"], ["restaurant", "orders", "create"], ["restaurant", "orders", "edit"], ["restaurant", "kds", "view"], ["restaurant", "kds", "create"], ["restaurant", "kds", "edit"], ["restaurant", "shifts", "view"], ["restaurant", "reports", "view"], ["restaurant", "reports", "export"], ["restaurant", "requisitions", "view"], ["restaurant", "requisitions", "create"], ["restaurant", "requisitions", "edit"], ["restaurant", "wastage", "view"], ["restaurant", "wastage", "create"], ["restaurant", "wastage", "edit"], ["stores", "overview", "view"],
  ].map(([module, feature, action]) => ({ module: module!, feature: feature!, action: action! })),
  "restaurant-manager": [
    ["ai", "insights", "view"], ["reports", "overview", "view"], ["reports", "overview", "export"], ["reports", "overview", "print"],
    ...["overview", "floor", "orders", "kds", "menu", "shifts"].flatMap((feature) => ["view", "create", "edit", "export", "print"].map((action) => ({ module: "restaurant", feature, action }))),
    ["restaurant", "reports", "view"], ["restaurant", "reports", "export"], ["restaurant", "reports", "print"], ["restaurant", "approvals", "view"],
    ...["requisitions", "wastage"].flatMap((feature) => ["view", "create", "edit", "approve", "export", "print"].map((action) => ({ module: "restaurant", feature, action }))),
    ["restaurant", "complimentary", "view"], ["restaurant", "complimentary", "create"], ["kitchen", "overview", "view"], ["kitchen", "queue", "view"], ["stores", "overview", "view"], ["marketing", "crm-customers", "view"],
  ].map((grant) => Array.isArray(grant) ? ({ module: grant[0]!, feature: grant[1]!, action: grant[2]! }) : grant),
  "front-office-manager": [
    ["ai", "insights", "view"], ["reports", "overview", "view"], ["reports", "overview", "export"], ["reports", "overview", "print"],
    ...["overview", "availability", "arrivals", "departures", "in-house", "rack", "reservations", "waitlist", "groups", "guests", "requests", "tasks", "stock_needs", "requisitions"].flatMap((feature) => ["view", "create", "edit", "export"].map((action) => ({ module: "front-office", feature, action }))),
    ["front-office", "folios", "view"], ["front-office", "folios", "create"], ["front-office", "folios", "edit"], ["front-office", "folios", "close"], ["front-office", "folios", "export"], ["front-office", "folios", "print"],
    ["front-office", "rates", "view"], ["front-office", "rates", "create"], ["front-office", "rates", "edit"], ["front-office", "reports", "view"], ["front-office", "reports", "export"], ["front-office", "reports", "print"],
    ["front-office", "complimentary", "request"], ["housekeeping", "board", "view"], ["marketing", "crm-customers", "view"],
  ].map((grant) => Array.isArray(grant) ? ({ module: grant[0]!, feature: grant[1]!, action: grant[2]! }) : grant),
  "laundry-manager": [
    ["ai", "insights", "view"], ["laundry", "overview", "view"], ["laundry", "overview", "create"], ["laundry", "overview", "edit"], ["laundry", "overview", "export"], ["laundry", "overview", "print"],
    ["laundry", "guest", "view"], ["laundry", "guest", "create"], ["laundry", "guest", "edit"], ["laundry", "my-work", "view"], ["laundry", "my-work", "edit"],
    ["laundry", "batches", "view"], ["laundry", "batches", "create"], ["laundry", "batches", "edit"], ["laundry", "batches", "assign"], ["laundry", "incidents", "view"], ["laundry", "incidents", "create"], ["laundry", "incidents", "edit"], ["laundry", "supplies", "view"], ["laundry", "supplies", "create"], ["laundry", "supplies", "edit"], ["laundry", "linen", "manage"],
    ["housekeeping", "overview", "view"], ["front-office", "rack", "view"], ["maintenance", "overview", "view"], ["reports", "overview", "view"], ["reports", "overview", "export"], ["reports", "overview", "print"],
  ].map(([module, feature, action]) => ({ module: module!, feature: feature!, action: action! })),
  "hot-kitchen-supervisor": [
    ["ai", "insights", "view"], ["kitchen", "overview", "view"], ["kitchen", "overview", "edit"], ["kitchen", "queue", "view"], ["kitchen", "queue", "edit"], ["kitchen", "my-station", "view"], ["kitchen", "my-station", "edit"], ["kitchen", "production", "view"], ["kitchen", "production", "create"], ["kitchen", "production", "edit"], ["kitchen", "recipes", "view"], ["kitchen", "needs", "view"], ["kitchen", "needs", "create"], ["kitchen", "needs", "edit"], ["kitchen", "stewarding", "view"], ["kitchen", "stewarding", "create"], ["kitchen", "stewarding", "edit"], ["kitchen", "quality", "view"], ["kitchen", "quality", "create"], ["kitchen", "quality", "edit"], ["kitchen", "hygiene", "view"], ["kitchen", "hygiene", "create"], ["kitchen", "hygiene", "edit"], ["kitchen", "waste", "view"], ["kitchen", "waste", "create"], ["kitchen", "waste", "edit"], ["kitchen", "*", "ticket.accept"], ["kitchen", "*", "item.prepare"], ["kitchen", "*", "item.ready"], ["restaurant", "kds", "view"], ["restaurant", "kds", "edit"],
  ].map(([module, feature, action]) => ({ module: module!, feature: feature!, action: action! })),
  "maintenance-officer": [
    ["ai", "insights", "view"], ["maintenance", "overview", "view"], ["maintenance", "overview", "create"], ["maintenance", "overview", "edit"], ["maintenance", "my-jobs", "view"], ["maintenance", "my-jobs", "edit"], ["maintenance", "grounds", "view"], ["maintenance", "grounds", "create"], ["maintenance", "grounds", "edit"], ["maintenance", "supplies", "view"], ["maintenance", "supplies", "create"], ["maintenance", "supplies", "edit"],
  ].map(([module, feature, action]) => ({ module: module!, feature: feature!, action: action! })),
  "social-media-manager": [
    ["ai", "insights", "view"], ["marketing", "overview", "view"], ["marketing", "content", "view"], ["marketing", "content", "create"], ["marketing", "content", "edit"], ["marketing", "calendar", "view"], ["marketing", "calendar", "create"], ["marketing", "calendar", "edit"], ["marketing", "campaigns", "view"], ["marketing", "campaigns", "create"], ["marketing", "campaigns", "edit"], ["marketing", "leads", "view"], ["marketing", "leads", "create"], ["marketing", "leads", "edit"], ["marketing", "reviews", "view"], ["marketing", "reviews", "create"], ["marketing", "reviews", "edit"], ["marketing", "feedback", "view"], ["marketing", "feedback", "create"], ["marketing", "feedback", "edit"], ["marketing", "tasks", "view"], ["marketing", "tasks", "create"], ["marketing", "tasks", "edit"], ["marketing", "stock_needs", "view"], ["marketing", "stock_needs", "create"], ["marketing", "crm-customers", "view"], ["marketing", "crm-customers", "create"], ["marketing", "crm-customers", "edit"], ["analytics", "overview", "view"], ["reports", "overview", "view"], ["reports", "overview", "export"],
  ].map(([module, feature, action]) => ({ module: module!, feature: feature!, action: action! })),
};

/**
 * Expands one role's template into the exact grants the database compiles for
 * it. `module.*` expands against the live capability registry, so a wildcard
 * template can never grant a feature the interface does not actually have.
 */
/**
 * Capabilities every provisioned staff role holds, whatever its title.
 *
 * NEØ Intelligence is universal *entry*, never universal *data*: the single
 * canonical key `ai.insights.view` opens the page, and every query the page
 * makes is still resolved through the effective-access contract (organisation,
 * property, department, station, ownership and sensitive-data permissions).
 */
export const ROLE_SPECIAL_CAPABILITIES: Record<string, CompiledGrant[]> = {
  // Operations Manager may execute a configured POS discount and approve it
  // only within the server-enforced <=15% ceiling. Above 15% remains Owner-only.
  owner: [
    { module: "kitchen", feature: "production", action: "manage" },
  ],
  "operations-manager": [
    { module: "pos", feature: "*", action: "discount.execute" },
    { module: "pos", feature: "*", action: "discount.approve" },
  ],
};

export const UNIVERSAL_VIEW_FEATURES = ["ai.insights"];

/**
 * Action authority — deliberately separate from data scope.
 *
 * Data scope answers "which records may this person reach?"; action authority
 * answers "what may they do to a record they can reach?". An Accountant may
 * legitimately read the whole organisation's ledger while still being unable
 * to approve a payment, close an accounting period or change accounting
 * configuration. Collapsing the two is what made Finance access contradictory:
 * widening someone's visibility silently widened their power.
 *
 * A limit names a `module.feature` and the only actions that survive for that
 * role, whatever its scope grants.
 */
export const ROLE_AUTHORITY_LIMITS: Record<string, Record<string, string[]>> = {
  cashier: {
    // Collection and till custody only. Refund, reversal, override, void,
    // reopening and accounting configuration are deliberately absent.
    "finance.collections": [
      "view",
      "collect_payment",
      "issue_receipt",
      "query_bill",
      "reprint_receipt",
      "settle_bill",
      "verify_bill",
    ],
    "finance.till": ["view", "create", "edit", "close", "confirm_cash", "declare_cash"],
    "finance.sessions": ["view", "create", "edit"],
  },
  accountant: {
    // Bookkeeping, yes. Closing the books, no — that is the Finance Manager's
    // configured authority.
    "finance.period": ["view"],
    // Prepare a payment; approving it is a separate authority.
    "finance.banking": ["view", "create", "export"],
  },
  "finance-manager": {
    // A Finance Manager runs Finance but does not administer the platform's
    // accounting integrations.
    "finance.quickbooks": ["view"],
  },
  // Oversight, not operation. An Operations Manager reads every department and
  // decides the things escalated to them; they do not author the master data,
  // post money or configure the platform.
  "operations-manager": {
    "*": ["view", "export", "print"],
  },
  // A waiter serves the tables the floor already has. Creating areas or tables
  // is floor master data, and that belongs to the outlet's manager.
  waiter: {
    "restaurant.floor": ["view"],
    "restaurant.shifts": ["view"],
  },
  barista: {
    "restaurant.floor": ["view"],
    "restaurant.shifts": ["view"],
  },
  // A station supervisor runs their own counter. Restaurant-wide floor plans,
  // the menu and shift administration stay with the restaurant manager.
  "coffee-station-supervisor": {
    "restaurant.shifts": ["view"],
    "restaurant.reports": ["view", "export", "print"],
  },
  // Custody of stock, not purchasing authority. Receiving against an order is
  // the store's job; raising and approving the order is not.
  storekeeper: {
    "procurement.receiving": ["view", "create", "edit"],
  },
};

/**
 * Features a limited role may still decide on.
 *
 * A blanket read-only limit would also silence the escalations, wastage and
 * approval inbox an Operations Manager exists to clear, so approval authority
 * is restored by feature name rather than by widening the whole role.
 */
export const ROLE_DECISION_FEATURES: Record<string, string[]> = {
  "operations-manager": [
    "approvals",
    "wastage",
    "waste",
    "complimentary",
    "requests",
    "stock-needs",
    "stock_needs",
    "needs",
  ],
};

const DECISION_ACTIONS = ["approve", "reject"];

/**
 * The actions a role keeps on one feature, after its authority limits.
 *
 * A limit may name an exact `module.feature`, a whole module as `module.*`, or
 * the entire role as `*`; the most specific entry wins.
 */
export function authorisedActions(
  roleKey: string,
  module: string,
  feature: string,
  scopeActions: string[],
): string[] {
  const limits = ROLE_AUTHORITY_LIMITS[roleKey];
  const limit =
    limits?.[`${module}.${feature}`] ?? limits?.[`${module}.*`] ?? limits?.["*"];
  if (!limit) return scopeActions;
  const decides = (ROLE_DECISION_FEATURES[roleKey] ?? []).includes(feature);
  const allowed = decides ? [...limit, ...DECISION_ACTIONS] : limit;
  return scopeActions.filter((a) => allowed.includes(a));
}


export function compileRoleTemplate(
  roleKey: string,
  featuresByModule: Record<string, string[]>,
): CompiledGrant[] {
  const exact = ROLE_EXACT_GRANTS[roleKey];
  if (exact) return exact.map((grant) => ({ ...grant }));
  const templated = ROLE_FEATURE_TEMPLATES[roleKey];
  // An unknown/unmapped role stays empty — universal capabilities belong to
  // provisioned roles only, never to an unrecognised one.
  if (!templated) return [];
  const actions = actionsForScope(ROLE_ACCESS_SCOPES[roleKey] ?? "self");
  const out: CompiledGrant[] = [];
  for (const entry of templated) {
    const dot = entry.indexOf(".");
    const module = entry.slice(0, dot);
    const feature = entry.slice(dot + 1);
    const features = feature === "*" ? (featuresByModule[module] ?? ["*"]) : [feature];
    for (const f of features)
      for (const action of authorisedActions(roleKey, module, f, actions))
        out.push({ module, feature: f, action });
  }
  // Universal capabilities are view-only, exactly as the database compiles them.
  for (const entry of UNIVERSAL_VIEW_FEATURES) {
    const dot = entry.indexOf(".");
    const module = entry.slice(0, dot);
    const feature = entry.slice(dot + 1);
    if (!out.some((g) => g.module === module && g.feature === feature && g.action === "view")) {
      out.push({ module, feature, action: "view" });
    }
  }
  for (const grant of ROLE_SPECIAL_CAPABILITIES[roleKey] ?? []) {
    if (!out.some((g) => g.module === grant.module && g.feature === grant.feature && g.action === grant.action)) {
      out.push({ ...grant });
    }
  }
  return out;
}
