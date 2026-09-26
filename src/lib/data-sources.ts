/**
 * Live-data source registry.
 *
 * A dashboard card and the operational page it summarises must read the same
 * backend service — otherwise the headline figure and the working list drift
 * apart and nobody can tell which one is true. Every card declares the module
 * it summarises and the backend sources it reads; every module declares its
 * route and the backend sources its pages read. The reconciliation test asserts
 * the card never reads outside its module's own sources.
 */

import { FACTS, FACT_METRIC_PREFIX, OPERATIONAL_FACT_PREFIX } from "@/lib/facts";
import { capabilityForPath, capabilityKey } from "@/lib/capabilities";

export type ModuleKey =
  | "front-office"
  | "housekeeping"
  | "restaurant"
  | "kitchen"
  | "delivery"
  | "finance";

export type ModuleSource = {
  /** Canonical operational route that owns the records. */
  route: string;
  /** Backend tables and RPCs the module's own pages read. */
  sources: string[];
};

export const MODULE_SOURCES: Record<ModuleKey, ModuleSource> = {
  "front-office": {
    route: "/pms",
    sources: ["reservations", "rooms", "room_types", "folios", "guest_requests", "customers"],
  },
  housekeeping: {
    route: "/housekeeping/board",
    sources: ["housekeeping_jobs", "housekeeping_job_results", "rooms", "deep_cleaning_schedules"],
  },
  restaurant: {
    route: "/pos/orders",
    sources: ["pos_orders", "pos_order_items", "pos_payments", "restaurant_tables"],
  },
  kitchen: {
    route: "/kitchen/queue",
    sources: ["station_tickets", "station_ticket_items", "operational_stations", "production_batches"],
  },
  delivery: {
    route: "/delivery",
    sources: ["delivery_orders", "delivery_order_status_history", "rider_profiles", "delivery_zones"],
  },
  finance: {
    route: "/finance/journals",
    sources: ["journal_entries", "journal_entry_lines", "payments", "invoices"],
  },
};

export type DashboardCard = {
  /** Stable card identifier used by the dashboard frame. */
  key: string;
  label: string;
  module: ModuleKey;
  /** Backend tables/RPCs this card reads — must be a subset of its module's. */
  sources: string[];
  /** Where clicking through takes the reader. */
  drillTo: string;
};

export const DASHBOARD_CARDS: DashboardCard[] = [
  { key: "arrivals-today", label: "Arrivals today", module: "front-office", sources: ["reservations"], drillTo: "/pms/arrivals" },
  { key: "departures-today", label: "Departures today", module: "front-office", sources: ["reservations"], drillTo: "/pms/departures" },
  { key: "rooms-sellable", label: "Sellable rooms", module: "front-office", sources: ["rooms"], drillTo: "/pms/rooms" },
  { key: "housekeeping-open", label: "Open housekeeping jobs", module: "housekeeping", sources: ["housekeeping_jobs"], drillTo: "/housekeeping/board" },
  { key: "housekeeping-inspection", label: "Awaiting inspection", module: "housekeeping", sources: ["housekeeping_jobs"], drillTo: "/housekeeping/inspections" },
  { key: "restaurant-open-orders", label: "Open orders", module: "restaurant", sources: ["pos_orders"], drillTo: "/pos/orders" },
  { key: "restaurant-sales", label: "Posted sales", module: "restaurant", sources: ["pos_orders", "pos_payments"], drillTo: "/pos/reports" },
  { key: "kitchen-queue", label: "Kitchen queue", module: "kitchen", sources: ["station_tickets", "station_ticket_items"], drillTo: "/kitchen/queue" },
  { key: "delivery-active", label: "Active deliveries", module: "delivery", sources: ["delivery_orders"], drillTo: "/delivery" },
  { key: "finance-posted", label: "Posted journals", module: "finance", sources: ["journal_entries"], drillTo: "/finance/journals" },
];

/* ------------------------------------------------------------------ *
 * Operations dashboard card contract
 * ------------------------------------------------------------------ *
 * Every card on the Operations dashboard is inventoried here against the same
 * backend service its operational page uses. There is no separate dashboard
 * table: each figure is read from `dashboard_metrics` / `department_workload`,
 * which aggregate the live operational tables named in `sourceTables`.
 */

export type CardScope =
  | "organization"
  | "property"
  | "department"
  | "station"
  | "personal";

export type OperationsCard = {
  key: string;
  label: string;
  /** Dot path into the dashboard_metrics payload, or the RPC for panels. */
  metric?: string;
  /** Authoritative backend service the card reads. */
  service: string;
  /** Live operational tables that service aggregates. */
  sourceTables: string[];
  /** Row filters the service applies. */
  filters: string;
  /** Date window applied, or "point-in-time" for current-state counts. */
  dateRange: string;
  /** Widest scope the figure may span; narrowed further by the scope selectors. */
  scope: CardScope;
  /** How the figure is derived. */
  calculation: string;
  /** What makes the card refetch. */
  refresh: string;
  /** Operational page that owns the underlying records. */
  drillTo: string;
  /**
   * Capability required to read the card. `"universal"` means every signed-in
   * member may see it because the records are already scoped to them.
   */
  capability: string;
};

const ORG_BRANCH_DEPT_STATION =
  "organization_id = current org; branch / department / station selectors when set";

export const OPERATIONS_CARDS: OperationsCard[] = [
  {
    key: "open-tasks",
    label: "Open tasks",
    metric: "tasks.open",
    service: "dashboard_metrics",
    sourceTables: ["tasks"],
    filters: `${ORG_BRANCH_DEPT_STATION}; status not in (completed, cancelled)`,
    dateRange: "point-in-time",
    scope: "department",
    calculation: "count of task rows still open",
    refresh: "60s poll · Refresh action · task mutation invalidation",
    drillTo: "/tasks",
    capability: "universal",
  },
  {
    key: "overdue-tasks",
    label: "Overdue tasks",
    metric: "tasks.overdue",
    service: "dashboard_metrics",
    sourceTables: ["tasks"],
    filters: `${ORG_BRANCH_DEPT_STATION}; due_at < now(); status not in (completed, cancelled)`,
    dateRange: "point-in-time",
    scope: "department",
    calculation: "count of open tasks past their due timestamp",
    refresh: "60s poll · Refresh action · task mutation invalidation",
    drillTo: "/tasks",
    capability: "universal",
  },
  {
    key: "unassigned-tasks",
    label: "Unassigned tasks",
    metric: "tasks.unassigned",
    service: "dashboard_metrics",
    sourceTables: ["tasks"],
    filters: `${ORG_BRANCH_DEPT_STATION}; assignee_id is null; status not in (completed, cancelled)`,
    dateRange: "point-in-time",
    scope: "department",
    calculation: "count of open tasks with no assignee",
    refresh: "60s poll · Refresh action · task mutation invalidation",
    drillTo: "/tasks",
    capability: "universal",
  },
  {
    key: "pending-approvals",
    label: "Pending approvals",
    metric: "approvals.pending",
    service: "dashboard_metrics",
    sourceTables: ["approval_requests"],
    filters: "organization_id = current org; branch / department selectors; status = pending",
    dateRange: "point-in-time",
    scope: "department",
    calculation: "count of approval requests awaiting a decision",
    refresh: "60s poll · Refresh action · approval decision invalidation",
    drillTo: "/approvals",
    capability: "universal",
  },
  {
    key: "approval-turnaround",
    label: "Approval turnaround",
    metric: "approvals.avg_turnaround_hours",
    service: "dashboard_metrics",
    sourceTables: ["approval_requests"],
    filters: "organization_id = current org; branch / department selectors; status in (approved, rejected)",
    dateRange: "selected reporting period",
    scope: "department",
    calculation: "mean hours between created_at and the decision timestamp",
    refresh: "60s poll · Refresh action",
    drillTo: "/approvals",
    capability: "universal",
  },
  {
    key: "unread-notifications",
    label: "Unread notifications",
    metric: "notifications.unread",
    service: "dashboard_metrics",
    sourceTables: ["notifications"],
    filters: "organization_id = current org; addressed to me or broadcast; read_at is null",
    dateRange: "point-in-time",
    scope: "personal",
    calculation: "count of unread notifications addressed to the reader",
    refresh: "60s poll · Refresh action · notification read invalidation",
    drillTo: "/notifications",
    capability: "universal",
  },
];

/** Cross-department workload panels on the Operations dashboard. */
export const OPERATIONS_PANELS: OperationsCard[] = [
  {
    key: "department-workload",
    label: "Department workload",
    service: "department_workload",
    sourceTables: ["tasks", "departments"],
    filters: "organization_id = current org; departments inside the reader's scope",
    dateRange: "point-in-time",
    scope: "organization",
    calculation: "open and overdue task counts grouped by department",
    refresh: "Refresh action · task mutation invalidation",
    drillTo: "/departments",
    capability: "administration.departments.view",
  },
  {
    key: "station-workload",
    label: "Station workload",
    service: "station_workload",
    sourceTables: ["tasks", "operational_stations"],
    filters: "organization_id = current org; stations inside the reader's scope",
    dateRange: "point-in-time",
    scope: "department",
    calculation: "open and overdue task counts grouped by station",
    refresh: "Refresh action · task mutation invalidation",
    drillTo: "/departments",
    capability: "administration.departments.view",
  },
  {
    key: "approvals",
    label: "Restricted-action requests awaiting my decision",
    service: "approval_requests",
    sourceTables: ["approval_requests", "approval_types"],
    filters: "organization_id = current org; status = pending; reader is an authorised approver",
    dateRange: "point-in-time",
    scope: "department",
    calculation: "pending approval rows the reader may decide",
    refresh: "Refresh action · approval decision invalidation",
    drillTo: "/approvals",
    capability: "universal",
  },
  {
    key: "team-tasks",
    label: "Overdue & open tasks",
    service: "tasks",
    sourceTables: ["tasks"],
    filters: `${ORG_BRANCH_DEPT_STATION}; status not in (completed, cancelled)`,
    dateRange: "point-in-time",
    scope: "department",
    calculation: "open task rows ordered by due date",
    refresh: "Refresh action · task mutation invalidation",
    drillTo: "/tasks",
    capability: "universal",
  },
  {
    key: "alerts",
    label: "Operational alerts",
    service: "dashboard_alerts",
    sourceTables: ["dashboard_alerts", "dashboard_alert_rules"],
    filters: "organization_id = current org; branch selector; unresolved",
    dateRange: "point-in-time",
    scope: "property",
    calculation: "open alert rows raised by the alert rules engine",
    refresh: "120s poll · Refresh action",
    drillTo: "/notifications",
    capability: "universal",
  },
  {
    key: "activity",
    label: "Recent activity",
    service: "audit_trail",
    sourceTables: ["audit_logs"],
    filters: "organization_id = current org; modules the reader may read",
    dateRange: "most recent entries",
    scope: "organization",
    calculation: "latest audit entries",
    refresh: "Refresh action",
    drillTo: "/audit-logs",
    capability: "administration.audit-logs.view",
  },
];

export const OPERATIONS_FACT_CARDS: OperationsCard[] = [
  {
    key: "rooms-attention",
    label: "Rooms to clean",
    metric: "facts.ops.housekeeping.dirty_rooms",
    service: "neo_operational_facts",
    sourceTables: ["ops_room_state", "housekeeping_jobs"],
    filters: "organization_id = current org; active property; housekeeping status = dirty",
    dateRange: "point-in-time",
    scope: "property",
    calculation: "count of rooms whose housekeeping state is dirty",
    refresh: "Refresh action · housekeeping mutation invalidation",
    drillTo: "/housekeeping",
    capability: "housekeeping.rooms.view",
  },
  {
    key: "guest-complaints",
    label: "Open guest feedback",
    metric: "facts.ops.crm.open_feedback",
    service: "neo_operational_facts",
    sourceTables: ["customer_feedback"],
    filters: "organization_id = current org; active property; status not resolved",
    dateRange: "point-in-time",
    scope: "property",
    calculation: "count of unresolved guest feedback records",
    refresh: "Refresh action · feedback mutation invalidation",
    drillTo: "/crm/feedback",
    capability: "crm.feedback.view",
  },
];

export const operationsCard = (key: string): OperationsCard | undefined =>
  OPERATIONS_CARDS.find((c) => c.key === key) ??
  OPERATIONS_PANELS.find((c) => c.key === key) ??
  OPERATIONS_FACT_CARDS.find((c) => c.key === key);

/* ------------------------------------------------------------------------- *
 * Metric-level contracts
 *
 * Every role dashboard renders its KPI tiles from the same `dashboard_metrics`
 * payload, so the authoritative contract belongs to the *metric path*, not to
 * the per-dashboard widget id. `metricContract` gives any card — on any role
 * dashboard — the same service, filters, scope, drill-down route and required
 * capability, which is what keeps a headline figure and its operational list
 * from drifting apart.
 * ------------------------------------------------------------------------- */

export type MetricContract = Omit<OperationsCard, "key" | "label"> & { metric: string };

const contract = (
  metric: string,
  sourceTables: string[],
  filters: string,
  calculation: string,
  drillTo: string,
  opts: Partial<MetricContract> = {},
): MetricContract => ({
  metric,
  service: "dashboard_metrics",
  sourceTables,
  filters,
  dateRange: "point-in-time",
  scope: "department",
  calculation,
  refresh: "60s poll · Refresh action · mutation invalidation",
  drillTo,
  capability: "universal",
  ...opts,
});

const TASK_FILTER = `${ORG_BRANCH_DEPT_STATION}; status not in (completed, cancelled)`;

export const METRIC_CONTRACTS: Record<string, MetricContract> = {
  "tasks.open": contract("tasks.open", ["tasks"], TASK_FILTER, "count of task rows still open", "/tasks"),
  "tasks.overdue": contract(
    "tasks.overdue",
    ["tasks"],
    `${TASK_FILTER}; due_at < now()`,
    "count of open tasks past their due timestamp",
    "/tasks",
  ),
  "tasks.unassigned": contract(
    "tasks.unassigned",
    ["tasks"],
    `${TASK_FILTER}; assignee_id is null`,
    "count of open tasks with no assignee",
    "/tasks",
  ),
  "tasks.in_progress": contract(
    "tasks.in_progress",
    ["tasks"],
    `${ORG_BRANCH_DEPT_STATION}; status = in_progress`,
    "count of tasks currently being worked",
    "/tasks",
  ),
  "tasks.completed": contract(
    "tasks.completed",
    ["tasks"],
    `${ORG_BRANCH_DEPT_STATION}; status = completed`,
    "count of tasks completed inside the reporting period",
    "/tasks",
    { dateRange: "selected reporting period" },
  ),
  "tasks.completion_rate": contract(
    "tasks.completion_rate",
    ["tasks"],
    `${ORG_BRANCH_DEPT_STATION}`,
    "completed tasks ÷ all tasks created in the period, as a percentage",
    "/tasks",
    { dateRange: "selected reporting period" },
  ),
  "tasks.mine_open": contract(
    "tasks.mine_open",
    ["tasks"],
    "organization_id = current org; assignee_id = auth.uid(); status not in (completed, cancelled)",
    "count of my own open tasks",
    "/tasks",
    { scope: "personal" },
  ),
  "tasks.mine_overdue": contract(
    "tasks.mine_overdue",
    ["tasks"],
    "organization_id = current org; assignee_id = auth.uid(); due_at < now(); status open",
    "count of my own overdue tasks",
    "/tasks",
    { scope: "personal" },
  ),
  "approvals.pending": contract(
    "approvals.pending",
    ["approval_requests"],
    "organization_id = current org; branch / department selectors; status = pending",
    "count of approval requests awaiting a decision",
    "/approvals",
  ),
  "approvals.delayed": contract(
    "approvals.delayed",
    ["approval_requests"],
    "organization_id = current org; status = pending; created_at < now() - 24h",
    "count of pending approvals older than 24 hours",
    "/approvals",
  ),
  "approvals.mine_pending": contract(
    "approvals.mine_pending",
    ["approval_requests"],
    "organization_id = current org; requested_by = auth.uid(); status = pending",
    "count of approvals I raised that are still undecided",
    "/approvals",
    { scope: "personal" },
  ),
  "approvals.avg_turnaround_hours": contract(
    "approvals.avg_turnaround_hours",
    ["approval_requests"],
    "organization_id = current org; status in (approved, rejected)",
    "mean hours between created_at and the decision timestamp",
    "/approvals",
    { dateRange: "selected reporting period" },
  ),
  "notifications.unread": contract(
    "notifications.unread",
    ["notifications"],
    "organization_id = current org; addressed to me or broadcast; read_at is null",
    "count of unread notifications addressed to the reader",
    "/notifications",
    { scope: "personal" },
  ),
  "staff.active": contract(
    "staff.active",
    ["profiles", "user_roles"],
    "organization_id = current org; status = active; branch / department selectors",
    "count of active staff accounts in scope",
    "/users",
    { scope: "organization", capability: "administration.users.view" },
  ),
  "staff.invited": contract(
    "staff.invited",
    ["profiles"],
    "organization_id = current org; status = invited",
    "count of invitations not yet accepted",
    "/users",
    { scope: "organization", capability: "administration.users.view" },
  ),
  "staff.suspended": contract(
    "staff.suspended",
    ["profiles"],
    "organization_id = current org; status = suspended",
    "count of suspended accounts",
    "/users",
    { scope: "organization", capability: "administration.users.view" },
  ),
  "staff.unassigned": contract(
    "staff.unassigned",
    ["profiles", "user_roles"],
    "organization_id = current org; no active role, branch or department assignment",
    "count of accounts missing a complete assignment",
    "/users",
    { scope: "organization", capability: "administration.users.view" },
  ),
  "staff.new_in_period": contract(
    "staff.new_in_period",
    ["profiles"],
    "organization_id = current org; created_at inside the reporting period",
    "count of staff accounts created in the period",
    "/users",
    {
      scope: "organization",
      capability: "administration.users.view",
      dateRange: "selected reporting period",
    },
  ),
  "structure.branches": contract(
    "structure.branches",
    ["branches"],
    "organization_id = current org; is_active",
    "count of active properties",
    "/admin/branches",
    { scope: "organization", capability: "administration.branches.view" },
  ),
  "structure.departments": contract(
    "structure.departments",
    ["departments"],
    "organization_id = current org; branch selector",
    "count of departments in scope",
    "/departments",
    { scope: "organization", capability: "administration.departments.view" },
  ),
  "structure.stations": contract(
    "structure.stations",
    ["operational_stations"],
    "organization_id = current org; branch / department selectors",
    "count of operational stations in scope",
    "/departments",
    { scope: "department", capability: "administration.departments.view" },
  ),
  "structure.roles": contract(
    "structure.roles",
    ["roles"],
    "organization_id = current org",
    "count of configured roles",
    "/roles",
    { scope: "organization", capability: "administration.roles.view" },
  ),
  "audit.events_24h": contract(
    "audit.events_24h",
    ["audit_logs"],
    "organization_id = current org; created_at > now() - 24h",
    "count of audit entries recorded in the last 24 hours",
    "/audit-logs",
    { scope: "organization", capability: "administration.audit-logs.view", dateRange: "last 24 hours" },
  ),
  "audit.security_events": contract(
    "audit.security_events",
    ["audit_logs"],
    "organization_id = current org; module = security or action in the security set",
    "count of security-classified audit entries in the period",
    "/audit-logs",
    {
      scope: "organization",
      capability: "administration.audit-logs.view",
      dateRange: "selected reporting period",
    },
  ),
};

/**
 * Canonical fact metrics. Dashboard, /analytics and /finance read the same
 * `neo_facts` payload, so a shared figure cannot differ between screens.
 */
for (const [path, def] of Object.entries(FACTS)) {
  const isFrontOffice = path.startsWith("front_office.");
  const isOperational = path.startsWith(OPERATIONAL_FACT_PREFIX);
  const routeCapability = capabilityForPath(def.drillTo);
  METRIC_CONTRACTS[`${FACT_METRIC_PREFIX}${path}`] = {
    metric: `${FACT_METRIC_PREFIX}${path}`,
    service: isOperational
      ? "neo_operational_facts"
      : isFrontOffice
        ? "neo_front_office_facts"
        : "neo_facts",
    sourceTables: isOperational
      ? ["neo_operational_facts (property-local operational snapshot)"]
      : isFrontOffice
        ? ["reservations", "ops_room_state (live room state)"]
        : ["neo_facts (canonical fact layer)"],
    filters:
      isFrontOffice || isOperational
        ? "organisation + authorised property scope; property-local operational date"
        : "organisation + authorised property scope; property-local reporting period",
    dateRange:
      isFrontOffice || isOperational
        ? "today (property timezone)"
        : "selected reporting period (property timezone)",
    scope: isOperational && path.startsWith("ops.waiter.") ? "personal" : "organization",
    calculation: def.eligibility,
    refresh: "60s poll · mutation invalidation",
    drillTo: def.drillTo,
    capability: isOperational
      ? routeCapability
        ? capabilityKey(routeCapability)
        : "universal"
      : isFrontOffice
        ? "front-office.overview.view"
        : path.startsWith("rooms.")
          ? "front-office.rooms.view"
          : "finance.finance.view",
  };
}


export const metricContract = (metric: string | undefined): MetricContract | undefined =>
  metric ? METRIC_CONTRACTS[metric] : undefined;

/**
 * Contract for a rendered card: the operations inventory wins when the card is
 * one of the named Operations tiles, otherwise the metric-level contract
 * applies — which is what lets every role dashboard share one source of truth.
 */
export function cardContract(
  key: string,
  metric?: string,
): OperationsCard | MetricContract | undefined {
  return operationsCard(key) ?? metricContract(metric);
}
