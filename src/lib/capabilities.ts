/**
 * Capability registry — the single source of truth for authorization.
 *
 * Every registered route, module tab and protected control resolves to exactly
 * one canonical capability `module.feature.action`. Navigation, route guards,
 * tab strips, buttons and the backend `public.has_permission()` all read the
 * same registry, so a link can never be shown for a page the guard refuses and
 * a button can never be enabled for a call the database rejects.
 *
 * Feature-level, deliberately: holding `restaurant.floor.view` no longer drags
 * in Orders, KDS, Reports or Settings the way a broad `restaurant.*.view`
 * module grant used to.
 */

export type Capability = { module: string; feature: string; action: string };

export const capabilityKey = (c: Capability) => `${c.module}.${c.feature}.${c.action}`;

export function parseCapability(key: string): Capability {
  const [module, feature, ...rest] = key.split(".");
  return { module: module ?? "", feature: feature ?? "*", action: rest.join(".") || "view" };
}

/** Pages every signed-in member may open regardless of module permissions. */
export const UNIVERSAL_ROUTES = new Set([
  "/",
  "/tasks",
  "/my-work",
  "/notifications",
  "/approvals",
  "/my-engagement",
  "/hr/me",
  "/dashboards",
  "/unauthorized",
  "/session-expired",
]);

type Entry = { prefix: string; module: string; feature: string; action?: string };

/**
 * Longest matching prefix wins, so `/pos/settings` resolves to the settings
 * feature while `/pos/orders/42` resolves to the orders feature.
 */
export const ROUTE_CAPABILITIES: Entry[] = [
  { prefix: "/staff-display-code", module: "kitchen", feature: "ticket", action: "accept" },
  { prefix: "/production-displays", module: "kitchen", feature: "production", action: "manage" },
  // ---------- Front Office ----------
  { prefix: "/pms", module: "front-office", feature: "overview" },
  { prefix: "/pms/arrivals", module: "front-office", feature: "arrivals" },
  { prefix: "/pms/departures", module: "front-office", feature: "departures" },
  { prefix: "/pms/in-house", module: "front-office", feature: "in-house" },
  { prefix: "/pms/availability", module: "front-office", feature: "availability" },
  { prefix: "/pms/rack", module: "front-office", feature: "rack" },
  // Operational stay board for housekeeping and F&B: same audience as the room
  // rack, deliberately no rates, folios or payment instruments.
  { prefix: "/stays", module: "front-office", feature: "rack" },
  { prefix: "/pms/rooms", module: "front-office", feature: "rack" },
  { prefix: "/pms/requests", module: "front-office", feature: "requests" },
  { prefix: "/pms/transport", module: "front-office", feature: "requests" },
  { prefix: "/pms/reservations", module: "front-office", feature: "reservations" },
  { prefix: "/pms/waitlist", module: "front-office", feature: "waitlist" },
  { prefix: "/pms/groups", module: "front-office", feature: "groups" },
  { prefix: "/pms/folios", module: "front-office", feature: "folios" },
  { prefix: "/pms/minibar", module: "front-office", feature: "folios" },
  { prefix: "/pms/tasks", module: "front-office", feature: "tasks" },
  { prefix: "/pms/requisitions", module: "front-office", feature: "requisitions" },
  { prefix: "/pms/supplies", module: "front-office", feature: "stock_needs" },
  { prefix: "/pms/reports", module: "front-office", feature: "intelligence" },
  { prefix: "/front-office", module: "front-office", feature: "overview" },
  { prefix: "/reservations", module: "front-office", feature: "reservations" },
  // Rooms & Types is the room-rack inventory surface; `front-office.rooms`
  // carries only block/upgrade authority and has no view action, so the screen
  // resolves — like its own in-page guard — to the rack feature.
  { prefix: "/rooms", module: "front-office", feature: "rack" },
  { prefix: "/guests", module: "front-office", feature: "guests" },
  { prefix: "/rates", module: "front-office", feature: "rates" },
  { prefix: "/credit-accounts", module: "front-office", feature: "credit-accounts" },

  // Production displays use the same feature grants as their department queues.
  { prefix: "/kitchen/display", module: "kitchen", feature: "queue" },
  { prefix: "/bar/display", module: "bar", feature: "queue" },
  { prefix: "/coffee/display", module: "kitchen", feature: "queue" },
  { prefix: "/pastry/display", module: "kitchen", feature: "pastry-production" },
  { prefix: "/production-overview", module: "kitchen", feature: "all_stations" },

  // ---------- Restaurant / POS ----------
  { prefix: "/pos", module: "restaurant", feature: "overview" },
  { prefix: "/pos/floor", module: "restaurant", feature: "floor" },
  { prefix: "/pos/orders", module: "restaurant", feature: "orders" },
  { prefix: "/pos/kds", module: "restaurant", feature: "kds" },
  // Selling reads the published menu inside the terminal; this route is the
  // catalogue management workspace and demands authoring authority.
  { prefix: "/pos/menu", module: "restaurant", feature: "menu", action: "edit" },
  { prefix: "/pos/shifts", module: "restaurant", feature: "shifts" },
  { prefix: "/pos/reports", module: "restaurant", feature: "reports" },
  { prefix: "/pos/requisitions", module: "restaurant", feature: "requisitions" },
  { prefix: "/pos/wastage", module: "restaurant", feature: "wastage" },
  { prefix: "/pos/settings", module: "restaurant", feature: "settings", action: "edit" },
  { prefix: "/pos/approvals", module: "restaurant", feature: "approvals", action: "approve" },
  { prefix: "/complimentary", module: "restaurant", feature: "complimentary" },

  // ---------- Bar (standalone department) ----------
  { prefix: "/bar", module: "bar", feature: "overview" },
  { prefix: "/bar/queue", module: "bar", feature: "queue" },
  // The selling surface is the bar's POS feature. There is no `bar.sell`
  // permission in the catalogue — asking for one hid the screen from every
  // role that did not hold the module wildcard.
  { prefix: "/bar/sell", module: "bar", feature: "pos" },
  { prefix: "/bar/menu", module: "bar", feature: "menu" },
  { prefix: "/bar/requisitions", module: "bar", feature: "requisitions" },
  { prefix: "/bar/wastage", module: "bar", feature: "wastage" },

  // Shared production-station stock is deliberately governed by the Stores
  // capability. Station membership further limits the rows in the database.
  { prefix: "/station-stock", module: "stores", feature: "overview" },

  // ---------- Kitchen ----------
  { prefix: "/kitchen", module: "kitchen", feature: "overview" },
  { prefix: "/kitchen/queue", module: "kitchen", feature: "queue" },
  { prefix: "/kitchen/my-station", module: "kitchen", feature: "my-station" },
  { prefix: "/kitchen/stewarding", module: "kitchen", feature: "stewarding" },
  { prefix: "/kitchen/needs", module: "kitchen", feature: "needs" },
  { prefix: "/kitchen/reorder", module: "kitchen", feature: "needs" },
  { prefix: "/kitchen/stock-count", module: "kitchen", feature: "stores" },
  { prefix: "/kitchen/production", module: "kitchen", feature: "production" },
  { prefix: "/kitchen/recipes", module: "kitchen", feature: "recipes" },
  { prefix: "/kitchen/quality", module: "kitchen", feature: "quality" },
  { prefix: "/kitchen/waste", module: "kitchen", feature: "waste" },
  { prefix: "/kitchen/stores", module: "kitchen", feature: "stores" },
  { prefix: "/kitchen/reports", module: "kitchen", feature: "reports" },
  { prefix: "/kitchen/settings", module: "kitchen", feature: "settings", action: "edit" },

  // ---------- Pastry & Bakery (a kitchen department with its own tiers) ----------
  { prefix: "/pastry", module: "kitchen", feature: "pastry-production" },
  { prefix: "/pastry/queue", module: "kitchen", feature: "pastry-production" },
  { prefix: "/pastry/production", module: "kitchen", feature: "pastry-schedule" },
  { prefix: "/pastry/my-production", module: "kitchen", feature: "pastry-production" },
  { prefix: "/pastry/custom-cakes", module: "kitchen", feature: "pastry-custom-orders" },
  { prefix: "/pastry/wastage", module: "kitchen", feature: "pastry-waste" },
  { prefix: "/pastry/needs", module: "kitchen", feature: "pastry-needs" },
  { prefix: "/pastry/requisitions", module: "kitchen", feature: "pastry-requisition" },

  // ---------- Security (Supervisor owns the department, Guard sees their post) ----------
  { prefix: "/security", module: "security-ops", feature: "overview" },
  { prefix: "/security/my-post", module: "security-ops", feature: "my-post" },
  { prefix: "/security/incidents", module: "security-ops", feature: "incidents" },
  { prefix: "/security/posts", module: "security-ops", feature: "posts" },
  { prefix: "/security/patrols", module: "security-ops", feature: "patrols" },
  { prefix: "/security/visitors", module: "security-ops", feature: "visitors" },
  { prefix: "/security/handovers", module: "security-ops", feature: "handovers" },
  { prefix: "/security/needs", module: "security-ops", feature: "stock-needs" },

  // ---------- Housekeeping / Laundry / Maintenance ----------
  { prefix: "/housekeeping", module: "housekeeping", feature: "overview" },
  { prefix: "/housekeeping/board", module: "housekeeping", feature: "board" },
  // The personal housekeeping surface is the "assigned work" feature every
  // cleaner legitimately holds; managers additionally hold `my-work.view`,
  // which is registered as an alternative below.
  { prefix: "/housekeeping/my-work", module: "housekeeping", feature: "assigned" },
  { prefix: "/housekeeping/supplies", module: "housekeeping", feature: "supplies" },
  { prefix: "/housekeeping/requisitions", module: "housekeeping", feature: "requisitions" },
  { prefix: "/housekeeping/tasks", module: "housekeeping", feature: "tasks" },
  { prefix: "/housekeeping/inspections", module: "housekeeping", feature: "inspections" },
  {
    prefix: "/housekeeping/lost-found",
    module: "housekeeping",
    feature: "lost-found",
    // The central register is a supervisory surface: reporting an item
    // (`lost-found.report`) must never open it.
    action: "manage",
  },
  { prefix: "/housekeeping/history", module: "housekeeping", feature: "reports" },
  { prefix: "/housekeeping/reports", module: "housekeeping", feature: "reports" },
  { prefix: "/laundry", module: "laundry", feature: "guest" },
  { prefix: "/laundry/my-work", module: "laundry", feature: "my-work" },
  { prefix: "/laundry/batches", module: "laundry", feature: "batches" },
  { prefix: "/laundry/incidents", module: "laundry", feature: "incidents" },
  { prefix: "/laundry/supplies", module: "laundry", feature: "supplies" },
  { prefix: "/maintenance", module: "maintenance", feature: "overview" },
  { prefix: "/maintenance/my-jobs", module: "maintenance", feature: "my-jobs" },
  { prefix: "/maintenance/grounds", module: "maintenance", feature: "grounds" },
  { prefix: "/maintenance/my-tasks", module: "maintenance", feature: "my-tasks" },
  { prefix: "/maintenance/landscaping", module: "maintenance", feature: "landscaping" },
  { prefix: "/maintenance/supplies", module: "maintenance", feature: "supplies" },
  // Viewing the category list is part of seeing the asset register; editing it
  // is gated inside the page on `maintenance.assets.manage`. There is no
  // `maintenance.assets.edit` permission, so gating the route on one hid the
  // page from every account, including the owner.
  { prefix: "/admin/asset-categories", module: "maintenance", feature: "assets", action: "view" },
  {
    prefix: "/admin/maintenance-categories",
    module: "maintenance",
    feature: "work_orders",
    action: "view",
  },
  { prefix: "/admin/grounds-areas", module: "maintenance", feature: "grounds", action: "view" },
  // The hotel's own room-cleaning standards: housekeeping management configures
  // them, attendants only ever execute the copy frozen on their job.
  {
    prefix: "/admin/housekeeping-standards",
    module: "housekeeping",
    feature: "checklists",
    action: "view",
  },
  // The hotel's own linen items. Laundry management configures them; laundry,
  // housekeeping and incident reporting all read the same canonical list.
  { prefix: "/admin/linen-catalogue", module: "laundry", feature: "overview", action: "view" },
  { prefix: "/admin/stock-policy", module: "stores", feature: "settings", action: "edit" },
  // The hotel's own public front door: discovery, customer services and which
  // of the four entrances appear. Administration owns it.
  {
    prefix: "/admin/public-experience",
    module: "administration",
    feature: "workspace",
    action: "view",
  },
  // One property's brand, media, words, services and publishing, in one place.
  {
    prefix: "/admin/experience-studio",
    module: "administration",
    feature: "workspace",
    action: "view",
  },
  // Joining the public NEØ platform: listing readiness for one property.
  { prefix: "/admin/neo-listing", module: "administration", feature: "workspace", action: "view" },
  {
    prefix: "/admin/partner-access",
    module: "administration",
    feature: "workspace",
    action: "view",
  },
  // Billing a corporate partner on credit, and the hotel side of partner messages.
  { prefix: "/admin/partner-billing", module: "finance", feature: "invoices", action: "view" },
  // The hotel's inbox of partner conversations.
  {
    prefix: "/admin/partner-messages",
    module: "procurement",
    feature: "suppliers",
    action: "view",
  },
  // What this property charges guests for laundry.
  { prefix: "/admin/laundry-pricing", module: "laundry", feature: "overview", action: "view" },

  { prefix: "/assets", module: "maintenance", feature: "assets" },

  // ---------- Supply chain ----------
  { prefix: "/inventory", module: "stores", feature: "overview" },
  { prefix: "/inventory/items", module: "stores", feature: "items" },
  { prefix: "/inventory/levels", module: "stores", feature: "overview" },
  { prefix: "/inventory/by-store", module: "stores", feature: "overview" },
  { prefix: "/inventory/live", module: "stores", feature: "overview" },
  { prefix: "/inventory/weekly-report", module: "stores", feature: "overview" },

  { prefix: "/inventory/receiving", module: "procurement", feature: "receiving" },
  { prefix: "/inventory/issues", module: "stores", feature: "issues" },
  { prefix: "/inventory/transfers", module: "stores", feature: "issues" },
  { prefix: "/inventory/needs", module: "stores", feature: "requisitions" },
  { prefix: "/inventory/requisitions", module: "stores", feature: "requisitions" },
  { prefix: "/inventory/counts", module: "stores", feature: "counts" },
  { prefix: "/inventory/tasks", module: "stores", feature: "tasks" },
  { prefix: "/inventory/reconciliation", module: "stores", feature: "reconciliation" },
  { prefix: "/inventory/settings", module: "stores", feature: "settings", action: "edit" },
  { prefix: "/procurement", module: "procurement", feature: "overview" },
  { prefix: "/procurement/dashboard", module: "procurement", feature: "overview" },
  { prefix: "/procurement/requests", module: "procurement", feature: "requests" },
  { prefix: "/procurement/orders", module: "procurement", feature: "orders" },
  { prefix: "/procurement/reconciliation", module: "procurement", feature: "orders" },
  { prefix: "/procurement/supplier-portal", module: "procurement", feature: "orders" },
  { prefix: "/procurement/branch", module: "procurement", feature: "overview" },
  { prefix: "/procurement/quotations", module: "procurement", feature: "quotations" },
  { prefix: "/procurement/suppliers", module: "procurement", feature: "suppliers" },
  // Follow-up work and buying-side supply needs are procurement surfaces of
  // their own; without these they fell back to the module front door.
  { prefix: "/procurement/tasks", module: "procurement", feature: "tasks" },
  { prefix: "/procurement/supplies", module: "procurement", feature: "supplies" },
  { prefix: "/procurement/settings", module: "procurement", feature: "settings", action: "edit" },
  { prefix: "/lpos", module: "procurement", feature: "lpos" },

  // ---------- Finance ----------
  // Granular by design. A single finance.overview grant used to decide whether
  // someone could see a dashboard, reconcile postings, run accounts payable and
  // close a period — four different responsibilities. Each now names its own
  // feature, so data scope and action authority can be configured apart.
  { prefix: "/finance", module: "finance", feature: "dashboard" },
  // The cashier queue hosts both stages: collecting money (cashier authority)
  // and recognising it (reconciliation authority, gated inside the page).
  { prefix: "/finance/queue", module: "finance", feature: "collections" },
  // The shared transaction register is read-only reconciliation evidence.
  { prefix: "/finance/register", module: "finance", feature: "reconciliation" },
  // The cashbook is read-only evidence of the money position, so it sits with
  // reconciliation rather than with posting authority.
  { prefix: "/finance/cashbook", module: "finance", feature: "reconciliation" },
  // The payment register is the shared collection evidence, read by anyone who
  // may see collections; verifying a hand-recorded tender is gated separately.
  { prefix: "/finance/payments", module: "finance", feature: "collections" },
  { prefix: "/finance/posting", module: "finance", feature: "reconciliation", action: "edit" },
  { prefix: "/finance/outbox", module: "finance", feature: "reconciliation", action: "edit" },
  {
    prefix: "/finance/commerce-check",
    module: "finance",
    feature: "reconciliation",
    action: "view",
  },
  // Must sit before "/finance/till" so the reconciliation report is not matched
  // by the cashier till prefix.
  {
    prefix: "/finance/till-reconciliation",
    module: "finance",
    feature: "reconciliation",
    action: "view",
  },
  { prefix: "/finance/collections", module: "finance", feature: "collections" },
  { prefix: "/finance/till", module: "finance", feature: "till" },
  { prefix: "/finance/sessions", module: "finance", feature: "sessions" },
  { prefix: "/finance/eod", module: "finance", feature: "eod" },
  { prefix: "/finance/revenue", module: "finance", feature: "dashboard" },
  { prefix: "/finance/profit-loss", module: "finance", feature: "dashboard" },
  { prefix: "/finance/general-ledger", module: "finance", feature: "gl" },
  { prefix: "/finance/ledger", module: "finance", feature: "gl" },
  { prefix: "/finance/journals", module: "finance", feature: "journals" },
  { prefix: "/finance/payroll-journal", module: "finance", feature: "journals" },
  { prefix: "/finance/payables", module: "finance", feature: "ap" },
  { prefix: "/finance/ap-matching", module: "finance", feature: "ap" },
  { prefix: "/finance/deposits", module: "finance", feature: "reconciliation" },
  { prefix: "/finance/receivables", module: "finance", feature: "receivables" },
  { prefix: "/finance/bank-accounts", module: "finance", feature: "banking" },
  { prefix: "/finance/banking", module: "finance", feature: "banking" },
  { prefix: "/finance/reconciliation", module: "finance", feature: "banking" },
  { prefix: "/finance/tax", module: "finance", feature: "tax" },
  { prefix: "/finance/ota", module: "finance", feature: "ota" },
  { prefix: "/finance/packages", module: "finance", feature: "packages" },
  { prefix: "/finance/quickbooks", module: "finance", feature: "quickbooks", action: "edit" },

  // ---------- CRM (marketing module) ----------
  // Features here must exist in the permission catalogue, otherwise the menu
  // entry and the screen both ask for something nobody can ever be granted.
  { prefix: "/crm", module: "marketing", feature: "crm-overview" },
  { prefix: "/crm/customers", module: "marketing", feature: "crm-customers" },
  { prefix: "/crm/corporate", module: "marketing", feature: "crm-corporate" },
  { prefix: "/crm/loyalty", module: "marketing", feature: "loyalty" },
  { prefix: "/crm/communications", module: "marketing", feature: "communications" },
  { prefix: "/crm/feedback", module: "marketing", feature: "feedback" },
  { prefix: "/crm/segments", module: "marketing", feature: "segments" },
  { prefix: "/crm/duplicates", module: "marketing", feature: "crm-customers" },
  { prefix: "/crm/settings", module: "marketing", feature: "crm-settings", action: "edit" },

  // ---------- Marketing ----------
  { prefix: "/marketing", module: "marketing", feature: "overview" },
  { prefix: "/marketing/leads", module: "marketing", feature: "leads" },
  { prefix: "/marketing/pipeline", module: "marketing", feature: "pipeline" },
  { prefix: "/marketing/segments", module: "marketing", feature: "segments" },
  { prefix: "/marketing/campaigns", module: "marketing", feature: "campaigns" },
  { prefix: "/marketing/calendar", module: "marketing", feature: "calendar" },
  { prefix: "/marketing/automations", module: "marketing", feature: "automations" },
  { prefix: "/marketing/templates", module: "marketing", feature: "templates" },
  { prefix: "/marketing/promotions", module: "marketing", feature: "promotions" },
  { prefix: "/marketing/referrals", module: "marketing", feature: "referrals" },
  { prefix: "/marketing/reviews", module: "marketing", feature: "reviews" },
  { prefix: "/marketing/recovery", module: "marketing", feature: "recovery" },
  { prefix: "/marketing/feedback", module: "marketing", feature: "feedback" },
  { prefix: "/marketing/consent", module: "marketing", feature: "consent" },
  { prefix: "/marketing/suppression", module: "marketing", feature: "suppression" },
  { prefix: "/marketing/reports", module: "marketing", feature: "reports" },
  { prefix: "/marketing/content", module: "marketing", feature: "content" },
  { prefix: "/marketing/tasks", module: "marketing", feature: "tasks" },
  { prefix: "/marketing/supplies", module: "marketing", feature: "stock_needs" },
  { prefix: "/marketing/settings", module: "marketing", feature: "settings", action: "edit" },

  // ---------- Events ----------
  { prefix: "/events", module: "events", feature: "overview" },
  { prefix: "/events/enquiries", module: "events", feature: "enquiries" },
  { prefix: "/events/quotations", module: "events", feature: "quotations" },
  { prefix: "/events/bookings", module: "events", feature: "bookings" },
  { prefix: "/events/calendar", module: "events", feature: "calendar" },
  { prefix: "/events/site-visits", module: "events", feature: "site-visits" },
  { prefix: "/events/readiness", module: "events", feature: "readiness" },
  { prefix: "/events/banqueting", module: "events", feature: "banqueting" },
  { prefix: "/events/service", module: "events", feature: "banqueting" },
  { prefix: "/events/reconciliation", module: "events", feature: "billing" },
  { prefix: "/events/payments", module: "events", feature: "billing", action: "create" },
  { prefix: "/events/my-tasks", module: "events", feature: "my_tasks" },
  { prefix: "/events/supplies", module: "events", feature: "stock_needs" },
  { prefix: "/events/resources", module: "events", feature: "resources" },
  { prefix: "/events/venues", module: "events", feature: "venues" },
  { prefix: "/events/packages", module: "events", feature: "packages" },
  { prefix: "/events/billing", module: "events", feature: "billing" },
  { prefix: "/events/feedback", module: "events", feature: "feedback" },
  { prefix: "/events/reports", module: "events", feature: "reports" },
  { prefix: "/events/settings", module: "events", feature: "settings", action: "edit" },

  // ---------- Delivery ----------
  { prefix: "/delivery", module: "delivery", feature: "overview" },
  // Dispatch desk screens: the order queue and the PIN verification board are
  // both dispatch work, not the generic delivery overview.
  { prefix: "/delivery/queue", module: "delivery", feature: "dispatch" },
  { prefix: "/delivery/verification", module: "delivery", feature: "dispatch" },
  { prefix: "/delivery/tasks", module: "delivery", feature: "tasks" },
  { prefix: "/delivery/requisitions", module: "delivery", feature: "requisitions" },
  { prefix: "/delivery/maintenance", module: "delivery", feature: "maintenance" },
  { prefix: "/delivery/reports", module: "delivery", feature: "reports" },
  // The rider workspace is the rider's own delivery work, not the dispatch
  // desk: it opens on the same `my-work` capability the rider role holds.
  { prefix: "/rider", module: "delivery", feature: "my-work" },
  { prefix: "/rider/support", module: "delivery", feature: "my-work" },
  { prefix: "/rider/profile", module: "delivery", feature: "my-work" },

  // ---------- Human Resources ----------
  { prefix: "/hr", module: "human-resources", feature: "overview" },
  { prefix: "/hr/employees", module: "human-resources", feature: "employees" },
  { prefix: "/hr/onboarding", module: "human-resources", feature: "employees" },
  { prefix: "/hr/attendance", module: "human-resources", feature: "attendance" },
  { prefix: "/hr/clock", module: "human-resources", feature: "attendance" },
  { prefix: "/hr/leave", module: "human-resources", feature: "leave" },
  { prefix: "/hr/payslips", module: "human-resources", feature: "payroll" },
  { prefix: "/hr/payroll", module: "human-resources", feature: "payroll" },
  { prefix: "/hr/performance", module: "human-resources", feature: "performance" },
  { prefix: "/hr/recruitment", module: "human-resources", feature: "recruitment" },
  { prefix: "/hr/scheduling", module: "human-resources", feature: "scheduling" },
  { prefix: "/hr/training", module: "human-resources", feature: "training" },
  { prefix: "/hr/settings", module: "human-resources", feature: "settings", action: "edit" },
  { prefix: "/hr/documents", module: "human-resources", feature: "documents" },
  { prefix: "/hr/movements", module: "human-resources", feature: "employees" },
  { prefix: "/hr/relations", module: "human-resources", feature: "relations" },
  { prefix: "/hr/supplies", module: "human-resources", feature: "stock_needs" },

  // ---------- Administration ----------
  { prefix: "/users", module: "administration", feature: "users" },
  { prefix: "/roles", module: "administration", feature: "roles" },
  { prefix: "/departments", module: "administration", feature: "departments" },
  { prefix: "/stations", module: "administration", feature: "stations" },
  { prefix: "/settings", module: "administration", feature: "settings", action: "edit" },
  { prefix: "/audit-logs", module: "administration", feature: "audit-logs" },
  { prefix: "/admin", module: "administration", feature: "workspace", action: "edit" },
  { prefix: "/onboarding", module: "administration", feature: "workspace", action: "edit" },

  // ---------- Configuration Centre deep pages ----------
  // Every configuration page carries its own capability. `/admin` alone is no
  // longer a blanket key: a member who may edit branding must not thereby be
  // able to open payment credentials or the access matrix.
  {
    prefix: "/admin/hotel-information",
    module: "administration",
    feature: "workspace",
    action: "edit",
  },
  { prefix: "/admin/branches", module: "administration", feature: "workspace", action: "edit" },
  { prefix: "/admin/regional", module: "administration", feature: "workspace", action: "edit" },
  {
    prefix: "/admin/configuration",
    module: "administration",
    feature: "workspace",
    action: "edit",
  },
  {
    prefix: "/admin/dashboard-cards",
    module: "administration",
    feature: "workspace",
    action: "edit",
  },
  {
    prefix: "/admin/brand-identity",
    module: "administration",
    feature: "branding",
    action: "edit",
  },
  {
    prefix: "/admin/dashboard-appearance",
    module: "administration",
    feature: "branding",
    action: "edit",
  },
  { prefix: "/admin/app-branding", module: "administration", feature: "branding", action: "edit" },
  { prefix: "/admin/documents", module: "administration", feature: "documents", action: "edit" },
  {
    prefix: "/admin/communication",
    module: "administration",
    feature: "communication",
    action: "edit",
  },
  { prefix: "/admin/user-defaults", module: "administration", feature: "users", action: "edit" },
  {
    prefix: "/admin/approval-limits",
    module: "administration",
    feature: "approvals",
    action: "edit",
  },
  {
    prefix: "/admin/approval-routing",
    module: "administration",
    feature: "approvals",
    action: "edit",
  },
  {
    prefix: "/admin/self-approval-exceptions",
    module: "administration",
    feature: "approvals",
    action: "edit",
  },
  { prefix: "/admin/access-matrix", module: "administration", feature: "roles", action: "edit" },
  { prefix: "/admin/role-testing", module: "administration", feature: "roles", action: "edit" },
  { prefix: "/admin/role-migration", module: "administration", feature: "roles", action: "edit" },
  {
    prefix: "/admin/workspace-preview",
    module: "administration",
    feature: "roles",
    action: "edit",
  },
  { prefix: "/admin/capability-map", module: "administration", feature: "roles", action: "edit" },
  { prefix: "/admin/integrity", module: "administration", feature: "audit-logs", action: "view" },
  { prefix: "/admin/go-live", module: "administration", feature: "audit-logs", action: "view" },
  { prefix: "/admin/ai-provider", module: "integrations", feature: "providers", action: "edit" },
  { prefix: "/admin/email-delivery", module: "integrations", feature: "providers", action: "edit" },
  { prefix: "/admin/ai-simulator", module: "ai", feature: "insights", action: "view" },
  { prefix: "/admin/payments-mpesa", module: "finance", feature: "payments", action: "edit" },
  { prefix: "/admin/tax-etims", module: "finance", feature: "tax", action: "edit" },
  { prefix: "/admin/menu-imports", module: "restaurant", feature: "menu", action: "edit" },
  { prefix: "/admin/meal-plans", module: "front-office", feature: "rates", action: "edit" },
  { prefix: "/admin/suppliers", module: "procurement", feature: "suppliers", action: "edit" },
  {
    prefix: "/admin/procurement-policy",
    module: "procurement",
    feature: "settings",
    action: "edit",
  },
  { prefix: "/admin/delivery-zones", module: "delivery", feature: "settings", action: "edit" },
  { prefix: "/admin/delivery-settings", module: "delivery", feature: "settings", action: "edit" },
  // Closing an accounting period is authority, not configuration.
  { prefix: "/admin/finance-periods", module: "finance", feature: "period", action: "edit" },

  // ---------- Automation (integrations module) ----------
  { prefix: "/automation", module: "integrations", feature: "overview" },
  { prefix: "/automation/workflows", module: "integrations", feature: "workflows" },
  { prefix: "/automation/templates", module: "integrations", feature: "templates" },
  { prefix: "/automation/queue", module: "integrations", feature: "queue" },
  { prefix: "/automation/events", module: "integrations", feature: "events" },
  { prefix: "/automation/rules", module: "integrations", feature: "rules" },
  { prefix: "/automation/failures", module: "integrations", feature: "failures" },
  { prefix: "/automation/providers", module: "integrations", feature: "providers", action: "edit" },
  { prefix: "/automation/settings", module: "integrations", feature: "settings", action: "edit" },

  // ---------- Platform ----------
  { prefix: "/platform", module: "platform", feature: "readiness" },
  { prefix: "/platform/environments", module: "platform", feature: "environments", action: "edit" },
  { prefix: "/platform/recovery", module: "administration", feature: "recovery", action: "view" },
  { prefix: "/platform/subscription", module: "platform", feature: "subscription" },
  { prefix: "/platform/operations", module: "platform", feature: "operations" },
  { prefix: "/platform/integrations", module: "integrations", feature: "centre" },
  { prefix: "/platform/migration", module: "migration", feature: "overview" },
  { prefix: "/platform/printers", module: "integrations", feature: "centre" },
  {
    prefix: "/platform/data-lifecycle",
    module: "administration",
    feature: "recovery",
    action: "view",
  },
  { prefix: "/platform/quality", module: "quality", feature: "overview" },
  { prefix: "/platform/configuration-health", module: "platform", feature: "readiness" },
  { prefix: "/platform/performance", module: "platform", feature: "operations" },
  { prefix: "/platform/simulation", module: "quality", feature: "simulation", action: "edit" },
  { prefix: "/platform/support", module: "support", feature: "overview" },

  // ---------- Intelligence ----------
  { prefix: "/analytics", module: "analytics", feature: "overview" },
  { prefix: "/analytics/catalogue", module: "analytics", feature: "catalogue" },
  { prefix: "/reports", module: "reports", feature: "overview" },
  { prefix: "/staff-board", module: "reports", feature: "overview" },
  { prefix: "/ai-insights", module: "ai", feature: "insights" },
];

/** Resolves a path to the capability it demands, or null for universal pages. */
export function capabilityForPath(path: string): Capability | null {
  const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (UNIVERSAL_ROUTES.has(clean)) return null;
  if (clean.startsWith("/dashboards")) return null;
  let best: Entry | null = null;
  for (const entry of ROUTE_CAPABILITIES) {
    if (clean === entry.prefix || clean.startsWith(`${entry.prefix}/`)) {
      if (!best || entry.prefix.length > best.prefix.length) best = entry;
    }
  }
  if (!best) return null;
  return { module: best.module, feature: best.feature, action: best.action ?? "view" };
}

/**
 * Equivalent capabilities that legitimately open the same page.
 *
 * A route demands one canonical capability, but some surfaces are reachable
 * through a second, equally intended grant — a cleaner who may *manage* lost
 * property clearly may open the register, and a supervisor holding
 * `housekeeping.my-work.view` reaches the same personal board a cleaner
 * reaches through `housekeeping.assigned.view`. This never widens a module:
 * every alternative names an explicit feature the role already holds.
 */
export const ROUTE_CAPABILITY_ALTERNATIVES: Record<string, Capability[]> = {
  "/staff-display-code": [
    { module: "bar", feature: "queue", action: "edit" },
    { module: "kitchen", feature: "item", action: "prepare" },
    { module: "kitchen", feature: "production", action: "manage" },
    { module: "kitchen", feature: "chef", action: "assign" },
    { module: "bar", feature: "queue", action: "assign" },
  ],
  "/production-displays": [
    { module: "kitchen", feature: "chef", action: "assign" },
    { module: "bar", feature: "queue", action: "assign" },
  ],
  // The stay board carries no money, so the teams who act on arrivals reach it
  // through the work they already hold: room work for housekeeping, service
  // work for food & beverage. It opens no other front-office surface.
  "/stays": [
    { module: "housekeeping", feature: "assigned", action: "view" },
    { module: "housekeeping", feature: "overview", action: "view" },
    { module: "housekeeping", feature: "board", action: "view" },
    { module: "restaurant", feature: "orders", action: "view" },
    { module: "restaurant", feature: "floor", action: "view" },
  ],
  "/housekeeping/my-work": [
    { module: "housekeeping", feature: "my-work", action: "view" },
    // Executing an assigned clean is the personal board's whole purpose, so a
    // housekeeper holding it reaches their own work. It opens nothing else.
    { module: "housekeeping", feature: "cleaning", action: "start" },
  ],
  // A rider's own workspace. The rider catalogue grants the assignment and
  // own-order capabilities rather than `delivery.my-work`, so without these
  // equivalents a provisioned rider signs in with no route to their own
  // deliveries. Neither alternative opens any other delivery surface.
  "/rider": [
    { module: "delivery", feature: "rider.assignment", action: "view" },
    { module: "delivery", feature: "orders", action: "view-own" },
  ],
  "/rider/support": [
    { module: "delivery", feature: "rider.assignment", action: "view" },
    { module: "delivery", feature: "orders", action: "view-own" },
  ],
  "/rider/profile": [
    { module: "delivery", feature: "rider.assignment", action: "view" },
    { module: "delivery", feature: "orders", action: "view-own" },
  ],
  // Supervisory custody authority also opens the register; a reporter's
  // `lost-found.report` never does.
  "/housekeeping/lost-found": [{ module: "housekeeping", feature: "lost-found", action: "edit" }],
  // The stock catalogue resolves through `stores.items` only. Supplier
  // administration is a procurement master, not a stock master: editing
  // vendors must never confer stock-item authority. Owner/System Admin reach
  // it through superuser parity, not through a supplier grant.
};

/** The canonical capability plus any registered equivalent (any one suffices). */
export function capabilitiesForPath(path: string): Capability[] {
  const primary = capabilityForPath(path);
  if (!primary) return [];
  const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return [primary, ...(ROUTE_CAPABILITY_ALTERNATIVES[clean] ?? [])];
}

/**
 * One page test shared by navigation, tabs, in-page guards and the route guard.
 *
 * There is no module-wide fallback: holding one feature of a module never opens
 * the module's other surfaces. A worker who is handed work reaches it through
 * the capability that page actually asks for (their personal work surface),
 * never by inheriting a manager's workspace.
 */
export function pathPermitted(
  can: (module: string, featureOrAction: string, action?: string) => boolean,
  path: string,
): boolean {
  const caps = capabilitiesForPath(path);
  if (caps.length === 0) return true;
  return caps.some((c) => can(c.module, c.feature, c.action));
}

/** Every capability the interface can demand, for compilation and testing. */
export function allRouteCapabilities(): Capability[] {
  return ROUTE_CAPABILITIES.map((e) => ({
    module: e.module,
    feature: e.feature,
    action: e.action ?? "view",
  }));
}

/** Feature list per module, derived from the registry (no hand-kept duplicate). */
export function moduleFeatures(): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const e of ROUTE_CAPABILITIES) (out[e.module] ??= new Set()).add(e.feature);
  // An equivalent capability is just as real a feature of the interface as the
  // canonical one — a role template may legitimately name either.
  for (const caps of Object.values(ROUTE_CAPABILITY_ALTERNATIVES)) {
    for (const c of caps) (out[c.module] ??= new Set()).add(c.feature);
  }
  return Object.fromEntries(Object.entries(out).map(([m, s]) => [m, [...s].sort()]));
}
