/**
 * Phase 3 — dashboard catalogue.
 *
 * The database owns the authoritative catalogue (`dashboard_definitions`) and the
 * configurable role mapping (`role_dashboard_assignments`). This module describes the
 * *presentation* of each dashboard key: which KPI tiles, panels and quick actions it shows.
 *
 * Widgets are either:
 *  - `live`            → backed by a real Phase 2 table via the `dashboard_metrics` RPC
 *  - `awaiting-module` → the operational module does not exist yet, so the tile states that
 *                        plainly instead of inventing a number.
 */

export type PanelKey =
  | "my-tasks"
  | "team-tasks"
  | "approvals"
  | "notifications"
  | "alerts"
  | "activity"
  | "task-trend"
  | "department-workload"
  | "station-workload"
  | "kpi-catalogue"
  | "ai-summary";

/**
 * A capability a widget or action depends on. When the reader does not hold
 * it, the surface is omitted from the dashboard entirely — a staff dashboard
 * must never be a wall of "Access denied" placeholders for figures the role
 * was never meant to own.
 */
export type WidgetCapability = { module: string; feature: string; action: string };

export type KpiWidget = {
  kind: "kpi";
  id: string;
  title: string;
  /** Dot path into the dashboard_metrics payload, e.g. "tasks.overdue". */
  metric?: string;
  /** `external` = provided by a third-party integration that is not connected. */
  source: "live" | "awaiting-module" | "external";
  kpiKey?: string;
  suffix?: string;
  note?: string;
  tone?: "default" | "accent" | "success" | "warning";
  requires?: WidgetCapability;
};

export type PanelWidget = {
  kind: "panel";
  id: string;
  title: string;
  panel?: PanelKey;
  source: "live" | "awaiting-module";
  note?: string;
  span?: 1 | 2 | 3;
  requires?: WidgetCapability;
};

export type Widget = KpiWidget | PanelWidget;

export type QuickAction = {
  label: string;
  to?: string;
  note?: string;
  requires?: WidgetCapability;
};

export type DashboardSpec = {
  key: string;
  name: string;
  purpose: string;
  scopeHint: string;
  widgets: Widget[];
  quickActions: QuickAction[];
};

const AWAIT_NOTE = "Available after the relevant module is implemented";

/**
 * Who a work figure actually counts.
 *
 * A department's open workload and the work assigned to the reader are two
 * different numbers, and showing the first one on a personal dashboard is how
 * a card ends up claiming "4 open tasks" beside a work area that correctly
 * reports "no assigned tasks". Every task figure therefore carries the
 * audience it was counted for, and the audience is stated on the card.
 */
export type WorkAudience = "mine" | "scope";

const TASK_AUDIENCE: Record<string, WorkAudience> = {
  "tasks.open": "scope",
  "tasks.overdue": "scope",
  "tasks.unassigned": "scope",
  "tasks.in_progress": "scope",
  "tasks.completed": "scope",
  "tasks.completion_rate": "scope",
  "tasks.mine_open": "mine",
  "tasks.mine_overdue": "mine",
};

const AUDIENCE_NOTE: Record<WorkAudience, string> = {
  mine: "Assigned to you",
  scope: "Everyone in this property / department scope, not only your own work",
};

export function workAudienceFor(metric: string | undefined): WorkAudience | null {
  if (!metric) return null;
  return TASK_AUDIENCE[metric] ?? null;
}

const kpi = (
  id: string,
  title: string,
  metric: string,
  opts: Partial<KpiWidget> = {},
): KpiWidget => {
  const audience = workAudienceFor(metric);
  const note = opts.note ?? (audience ? AUDIENCE_NOTE[audience] : undefined);
  return {
    kind: "kpi",
    id,
    title,
    metric,
    source: "live",
    ...opts,
    ...(note ? { note } : {}),
  };
};

/** A figure only an external provider can supply, e.g. a payment gateway. */
const external = (id: string, title: string, note: string): KpiWidget => ({
  kind: "kpi",
  id,
  title,
  source: "external",
  note,
});

/**
 * A KPI backed by the canonical fact layer (`neo_facts`). The `facts.` prefix
 * tells the dashboard to read the shared payload used by /analytics and
 * /finance rather than the task-oriented `dashboard_metrics` payload.
 */
const fact = (id: string, title: string, path: string, opts: Partial<KpiWidget> = {}): KpiWidget =>
  kpi(id, title, `facts.${path}`, opts);

const panel = (id: string, title: string, p: PanelKey, span: 1 | 2 | 3 = 1): PanelWidget => ({
  kind: "panel",
  id,
  title,
  panel: p,
  source: "live",
  span,
});

const soonPanel = (id: string, title: string, note = AWAIT_NOTE): PanelWidget => ({
  kind: "panel",
  id,
  title,
  source: "awaiting-module",
  note,
});

/** Housekeeping department board authority vs. a cleaner's own assigned work. */
const HK_BOARD: WidgetCapability = { module: "housekeeping", feature: "board", action: "view" };
const HK_ASSIGNED: WidgetCapability = {
  module: "housekeeping",
  feature: "assigned",
  action: "view",
};


const CORE_LIVE: Widget[] = [
  kpi("open-tasks", "Open tasks", "tasks.open"),
  kpi("overdue-tasks", "Overdue tasks", "tasks.overdue", { tone: "warning" }),
  kpi("pending-approvals", "Pending approvals", "approvals.pending", { tone: "accent" }),
  kpi("unread-notifications", "Unread notifications", "notifications.unread"),
];

const STATION_WIDGETS = (label: string): Widget[] => [
  fact("new-items", `New ${label} items`, "ops.station.new_items"),
  fact("items-preparing", "Items in preparation", "ops.station.items_preparing"),
  fact("items-ready", "Ready items", "ops.station.items_ready"),
  fact("avg-prep", "Average preparation time", "ops.station.avg_prep_minutes"),
  fact("low-stock", "Low-stock items", "ops.inventory.low_stock", { tone: "warning" }),
  kpi("station-open-tasks", "Open station tasks", "tasks.open"),
  kpi("station-overdue", "Overdue station tasks", "tasks.overdue", { tone: "warning" }),
  panel("my-tasks", "My tasks", "my-tasks"),
  panel("notifications", "Station notifications", "notifications"),
];

const STATION_ACTIONS: QuickAction[] = [
  { label: "Open kitchen queue", to: "/kitchen/queue" },
  { label: "Point-of-sale display", to: "/pos/kds" },
  { label: "Stock levels", to: "/inventory" },
  { label: "Create task", to: "/tasks" },
  { label: "Report shortage", to: "/tasks" },
];

export const DASHBOARDS: Record<string, DashboardSpec> = {
  owner: {
    key: "owner",
    name: "Owner Dashboard",
    purpose: "Organisation-wide visibility across your authorised branches.",
    scopeHint: "Organisation",
    widgets: [
      fact("revenue-today", "Recognised revenue today", "accounting.revenue_today"),
      fact("revenue-week", "Recognised revenue this week", "accounting.revenue_week"),
      fact("revenue-month", "Recognised revenue this month", "accounting.revenue_month"),
      fact("occupancy", "Occupancy rate", "rooms.occupancy_rate", { suffix: "%" }),
      kpi("pending-approvals", "Pending approvals", "approvals.pending", { tone: "accent" }),
      kpi("overdue-tasks", "Overdue tasks", "tasks.overdue", { tone: "warning" }),
      kpi("task-completion", "Task completion rate", "tasks.completion_rate", { suffix: "%" }),
      kpi("approval-turnaround", "Approval turnaround", "approvals.avg_turnaround_hours", {
        suffix: " h",
      }),
      kpi("active-staff", "Active staff", "staff.active"),
      kpi("branches", "Active branches", "structure.branches"),
      fact("receivables", "Accounts receivable", "receivables.total"),
      fact("payables", "Accounts payable", "payables.total"),
      fact("cost-of-sales", "Cost of sales", "accounting.cost_of_sales"),
      fact("gross-profit", "Gross profit", "accounting.gross_profit"),
      fact("gross-margin", "Gross margin", "accounting.gross_margin", { suffix: "%" }),
      fact("payroll-cost", "Payroll cost", "accounting.payroll_cost"),
      fact("net-profit", "Net profit", "accounting.net_profit"),
      fact("stock-turnover", "Stock turnover", "inventory.stock_turnover"),
      panel("task-trend", "Task activity trend", "task-trend", 2),
      panel("alerts", "Operational alerts", "alerts"),
      panel("department-workload", "Department workload", "department-workload", 2),
      panel("approvals", "Pending approvals", "approvals"),
      panel("ai-summary", "AI business summary", "ai-summary", 2),
      panel("activity", "Recent activity", "activity"),
      fact("delivery-sales", "Delivery sales today", "ops.delivery.sales_today"),
      fact("guest-rating", "Average guest rating", "ops.crm.avg_rating"),
    ],
    quickActions: [
      { label: "View reports", to: "/reports" },
      { label: "Review approvals", to: "/approvals" },
      { label: "Department performance", to: "/departments" },
      { label: "AI recommendations", to: "/ai-insights" },
      { label: "Audit trail", to: "/audit-logs" },
    ],
  },
  operations: {
    key: "operations",
    name: "Operations Dashboard",
    purpose:
      "Cross-department operational control and restricted-action approvals for the assigned property.",
    scopeHint: "Branch",
    widgets: [
      ...CORE_LIVE,
      kpi("unassigned-tasks", "Unassigned tasks", "tasks.unassigned"),
      kpi("approval-turnaround", "Approval turnaround", "approvals.avg_turnaround_hours", {
        suffix: " h",
      }),
      panel("approvals", "Restricted-action requests awaiting my decision", "approvals", 2),
      panel("department-workload", "Department workload", "department-workload", 2),
      panel("alerts", "Operational alerts", "alerts"),
      panel("team-tasks", "Overdue & open tasks", "team-tasks", 2),
      panel("activity", "Recent activity", "activity"),
      fact("rooms-attention", "Rooms to clean", "ops.housekeeping.dirty_rooms"),
      fact("guest-complaints", "Open guest feedback", "ops.crm.open_feedback"),
    ],
    quickActions: [
      { label: "Review approvals", to: "/approvals" },
      { label: "Assign task", to: "/tasks" },
      { label: "Housekeeping board", to: "/housekeeping/board" },
      { label: "Maintenance issues", to: "/maintenance" },
      { label: "Departments", to: "/departments" },
    ],
  },
  "general-manager": {
    key: "general-manager",
    name: "Operations Manager Dashboard",
    purpose:
      "Whole-property command view: hotel today, the day's financial snapshot and every decision waiting on the Operations Manager.",
    scopeHint: "Branch",
    widgets: [
      // Hotel today
      fact("occupancy", "Hotel occupancy", "rooms.occupancy_rate", { suffix: "%" }),
      fact("arrivals", "Today's arrivals", "front_office.arrivals_today"),
      fact("departures", "Today's departures", "front_office.departures_today"),
      fact("in-house", "Guests in house", "front_office.in_house"),
      fact("rooms-available", "Rooms available", "front_office.rooms_available"),
      fact("rooms-attention", "Rooms to clean", "ops.housekeeping.dirty_rooms"),
      fact("awaiting-inspection", "Awaiting inspection", "ops.housekeeping.awaiting_inspection"),
      fact("rooms-out-of-order", "Out of order", "front_office.rooms_out_of_order"),
      // Financial snapshot
      fact("revenue-today", "Recognised revenue today", "accounting.revenue_today"),
      fact("restaurant-sales", "Restaurant & bar sales", "ops.restaurant.sales_today"),
      fact("delivery-sales", "Delivery sales today", "ops.delivery.sales_today"),
      fact("open-bills", "Open bills", "ops.restaurant.open_bills"),
      fact("receivables", "Outstanding receivables", "receivables.total"),
      // Approvals, escalations and department load
      ...CORE_LIVE,
      kpi("unassigned-tasks", "Unassigned tasks", "tasks.unassigned"),
      kpi("approval-turnaround", "Approval turnaround", "approvals.avg_turnaround_hours", {
        suffix: " h",
      }),
      kpi("active-staff", "Staff on the roster", "staff.active"),
      panel("approvals", "Requests awaiting my decision", "approvals", 2),
      panel("department-workload", "Department workload", "department-workload", 2),
      panel("alerts", "Operational alerts", "alerts"),
      panel("team-tasks", "Overdue & open tasks", "team-tasks", 2),
      panel("task-trend", "Task activity trend", "task-trend", 2),
      panel("activity", "Recent activity", "activity"),
      // Department signals
      fact("kitchen-delays", "Delayed kitchen items", "ops.kitchen.delayed_items"),
      fact("maintenance-open", "Open work orders", "ops.maintenance.open_work_orders"),
      fact("low-stock", "Low-stock items", "ops.inventory.low_stock"),
      fact("procurement-approval", "Requests awaiting approval", "ops.procurement.awaiting_approval"),
      fact("guest-complaints", "Open guest feedback", "ops.crm.open_feedback"),
      fact("events-today", "Events today", "ops.events.today"),
    ],
    quickActions: [
      { label: "Review approvals", to: "/approvals" },
      { label: "Assign task", to: "/tasks" },
      { label: "Housekeeping board", to: "/housekeeping/board" },
      { label: "Maintenance issues", to: "/maintenance" },
      { label: "Reports & BI", to: "/reports" },
      { label: "Departments", to: "/departments" },
    ],
  },

  administration: {
    key: "administration",
    name: "Administration Dashboard",
    purpose: "Platform configuration, staffing and security monitoring.",
    scopeHint: "Organisation",
    widgets: [
      kpi("active-staff", "Active staff", "staff.active", { tone: "success" }),
      kpi("invited", "Pending invitations", "staff.invited"),
      kpi("suspended", "Suspended users", "staff.suspended", { tone: "warning" }),
      kpi("unassigned", "Incomplete assignments", "staff.unassigned", { tone: "warning" }),
      kpi("roles", "Roles configured", "structure.roles"),
      kpi("departments", "Departments", "structure.departments"),
      kpi("stations", "Operational stations", "structure.stations"),
      kpi("branches", "Branches", "structure.branches"),
      kpi("audit-24h", "Audit events (24 h)", "audit.events_24h"),
      kpi("security-events", "Security events", "audit.security_events", { tone: "warning" }),
      panel("alerts", "Security & configuration alerts", "alerts"),
      panel("activity", "Recent audit events", "activity", 2),
      panel("kpi-catalogue", "KPI definitions", "kpi-catalogue", 2),
      panel("notifications", "System notifications", "notifications"),
      soonPanel("integrations", "External integration status", "No external provider is connected — configure one in Platform → Integrations"),
    ],
    quickActions: [
      { label: "Add staff member", to: "/users" },
      { label: "Assign roles", to: "/roles" },
      { label: "Departments & stations", to: "/departments" },
      { label: "View audit logs", to: "/audit-logs" },
      { label: "System settings", to: "/settings" },
    ],
  },
  finance: {
    key: "finance",
    name: "Finance Dashboard",
    purpose: "Authorised financial operations and reconciliation.",
    scopeHint: "Organisation",
    widgets: [
      fact("daily-revenue", "Recognised revenue today", "accounting.revenue_today"),
      fact("collections", "Payments collected", "collections.total"),
      fact("cash-variance", "Cash variance today", "ops.finance.cash_variance_today"),
      fact("shifts-review", "Shifts awaiting review", "ops.finance.shifts_awaiting_review", { tone: "warning" }),
      fact("payments-today", "Payments collected today", "ops.finance.payments_today"),
      fact("receivables", "Accounts receivable", "receivables.total"),
      fact("payables", "Accounts payable", "payables.total"),
      fact("posted-revenue", "Posted accounting revenue", "accounting.posted_revenue"),
      fact("cost-of-sales", "Cost of sales", "accounting.cost_of_sales"),
      fact("gross-profit", "Gross profit", "accounting.gross_profit"),
      fact("gross-margin", "Gross margin", "accounting.gross_margin"),
      fact("payroll-cost", "Payroll cost", "accounting.payroll_cost"),
      fact("operating-expenses", "Operating expenses", "accounting.operating_expenses"),
      fact("net-profit", "Net profit", "accounting.net_profit"),
      fact("stock-value", "Stock value on hand", "inventory.closing_valuation"),
      fact("stock-turnover", "Stock turnover", "inventory.stock_turnover"),
      external("mpesa", "M-Pesa transactions", "Connect the M-Pesa provider in Platform → Integrations"),
      external("card", "Card transactions", "Connect the card acquirer in Platform → Integrations"),
      external("vcc", "Booking.com VCC collections", "Connect the channel manager in Platform → Integrations"),
      external("etims", "KRA eTIMS status", "Connect KRA eTIMS in Platform → Integrations"),
      kpi("pending-approvals", "Financial approvals pending", "approvals.pending", {
        tone: "accent",
      }),
      kpi("delayed-approvals", "Approvals delayed > 24 h", "approvals.delayed", {
        tone: "warning",
      }),
      kpi("turnaround", "Approval turnaround", "approvals.avg_turnaround_hours", { suffix: " h" }),
      panel("approvals", "Void, refund & expense requests", "approvals", 2),
      panel("alerts", "Finance alerts", "alerts"),
      panel("my-tasks", "My finance tasks", "my-tasks"),
      panel("activity", "Recent financial audit events", "activity", 2),
    ],
    quickActions: [
      { label: "Review approvals", to: "/approvals" },
      { label: "Credit accounts", to: "/credit-accounts" },
      { label: "Finance workspace", to: "/finance" },
      { label: "Receivables & invoices", to: "/finance/receivables" },
      { label: "Tax & eTIMS", to: "/finance/tax" },
    ],
  },
  "front-office": {
    key: "front-office",
    name: "Front Office Dashboard",
    purpose: "Guest arrivals, departures and room activity.",
    scopeHint: "Department",
    widgets: [
      fact("arrivals", "Today's arrivals", "front_office.arrivals_today"),
      fact("departures", "Today's departures", "front_office.departures_today"),
      fact("checkins", "Check-ins completed", "front_office.checkins_completed"),
      fact("in-house", "Guests in house", "front_office.in_house"),
      fact("available-rooms", "Available rooms", "front_office.rooms_available"),
      fact("occupied-rooms", "Occupied rooms", "front_office.rooms_occupied"),
      fact("ooo-rooms", "Out-of-order rooms", "front_office.rooms_out_of_order", {
        tone: "warning",
      }),
      fact("dirty-rooms", "Rooms to clean", "front_office.rooms_dirty"),
      ...CORE_LIVE,
      panel("my-tasks", "Front office tasks", "my-tasks"),
      panel("approvals", "Rate override & complimentary requests", "approvals", 2),
      panel("notifications", "Room readiness notifications", "notifications"),
    ],
    quickActions: [
      { label: "Create task", to: "/tasks" },
      { label: "Send housekeeping request", to: "/tasks" },
      { label: "Request rate override", to: "/approvals" },
      { label: "New reservation", to: "/pms/reservations/new" },
      { label: "Check in guest", to: "/pms/arrivals" },
      { label: "Guest folios", to: "/pms/folios" },
    ],
  },
  "restaurant-operations": {
    key: "restaurant-operations",
    name: "Restaurant Operations",
    purpose: "Coordination across floor, coffee station, bar, hot kitchen and pastry.",
    scopeHint: "Department",
    widgets: [
      fact("active-tables", "Active tables", "ops.restaurant.active_tables"),
      fact("orders-progress", "Orders in progress", "ops.restaurant.orders_in_progress"),
      fact("orders-ready", "Orders ready", "ops.restaurant.orders_ready"),
      fact("open-bills", "Open bills", "ops.restaurant.open_bills"),
      fact("open-value", "Open bill value", "ops.restaurant.open_value"),
      fact("restaurant-sales", "Restaurant sales", "ops.restaurant.sales_today"),
      fact("avg-service", "Average service time", "ops.restaurant.avg_service_minutes"),
      ...CORE_LIVE,
      panel("station-workload", "Station workload", "station-workload", 2),
      panel("approvals", "Void, discount & complimentary requests", "approvals"),
      panel("team-tasks", "Restaurant tasks", "team-tasks", 2),
      panel("alerts", "Restaurant alerts", "alerts"),
    ],
    quickActions: [
      { label: "Assign task", to: "/tasks" },
      { label: "Request bill void", to: "/approvals" },
      { label: "Request discount", to: "/approvals" },
      { label: "Raise Stores requisition", to: "/pos/requisitions" },
      { label: "Wastage log", to: "/pos/wastage" },
      { label: "Point-of-sale orders", to: "/pos/orders" },
    ],
  },
  "restaurant-floor": {
    key: "restaurant-floor",
    name: "Restaurant Floor Dashboard",
    purpose: "Table service, orders awaiting service and personal shift tasks.",
    scopeHint: "Station",
    widgets: [
      fact("assigned-tables", "Assigned tables", "ops.waiter.assigned_tables"),
      fact("orders-awaiting", "Orders awaiting service", "ops.waiter.orders_awaiting_service"),
      fact("orders-ready", "Orders ready for collection", "ops.waiter.orders_ready"),
      fact("my-open-bills", "My open bills", "ops.waiter.open_bills"),
      fact("service-delays", "Service delays", "ops.waiter.service_delays", { tone: "warning" }),
      kpi("my-open-tasks", "My open tasks", "tasks.mine_open"),
      kpi("my-overdue", "My overdue tasks", "tasks.mine_overdue", { tone: "warning" }),
      kpi("my-requests", "My pending requests", "approvals.mine_pending", { tone: "accent" }),
      kpi("unread", "Unread notifications", "notifications.unread"),
      panel("my-tasks", "My tasks", "my-tasks", 2),
      panel("approvals", "My requests", "approvals"),
      panel("notifications", "Floor notifications", "notifications"),
    ],
    quickActions: [
      { label: "Request discount", to: "/approvals" },
      { label: "Request bill void", to: "/approvals" },
      { label: "Request complimentary meal", to: "/approvals" },
      { label: "Request assistance", to: "/tasks" },
      { label: "Point-of-sale orders", to: "/pos/orders" },
    ],
  },
  "coffee-station": {
    key: "coffee-station",
    name: "Coffee Station Dashboard",
    purpose: "Coffee station queue, workload and tasks.",
    scopeHint: "Station",
    widgets: STATION_WIDGETS("coffee station"),
    quickActions: [
      ...STATION_ACTIONS,
      { label: "Raise Stores requisition", to: "/pos/requisitions" },
      { label: "Wastage log", to: "/pos/wastage" },
    ],
  },
  bar: {
    key: "bar",
    name: "Bar Dashboard",
    purpose: "Bar service queue, own workload, bar sales, approvals, stock and wastage.",
    scopeHint: "Department",
    widgets: STATION_WIDGETS("bar"),
    quickActions: [
      { label: "Bar dashboard", to: "/bar" },
      { label: "Bar order queue", to: "/bar/queue" },
      ...STATION_ACTIONS,
      { label: "Raise Stores requisition", to: "/bar/requisitions" },
      { label: "Bar wastage log", to: "/bar/wastage" },
    ],
  },
  "kitchen-overview": {
    key: "kitchen-overview",
    name: "Kitchen Overview",
    purpose: "Production monitoring across hot kitchen and pastry stations.",
    scopeHint: "Department",
    widgets: [
      fact("new-items", "New kitchen items", "ops.kitchen.new_items"),
      fact("in-preparation", "Items in preparation", "ops.kitchen.items_preparing"),
      fact("ready", "Ready items", "ops.kitchen.items_ready"),
      fact("delayed", "Delayed items", "ops.kitchen.delayed_items", { tone: "warning" }),
      fact("avg-prep", "Average preparation time", "ops.kitchen.avg_prep_minutes"),
      kpi("open-tasks", "Open kitchen tasks", "tasks.open"),
      kpi("overdue-tasks", "Overdue kitchen tasks", "tasks.overdue", { tone: "warning" }),
      kpi("unread", "Unread notifications", "notifications.unread"),
      panel("station-workload", "Station performance", "station-workload", 2),
      panel("team-tasks", "Kitchen tasks", "team-tasks"),
      panel("notifications", "Kitchen notifications", "notifications"),
    ],
    quickActions: [
      { label: "Assign kitchen task", to: "/tasks" },
      { label: "Station status", to: "/departments" },
      { label: "Kitchen queue", to: "/kitchen/queue" },
      { label: "Kitchen display", to: "/pos/kds" },
      { label: "Recipes", to: "/kitchen/recipes" },
    ],
  },
  "hot-kitchen": {
    key: "hot-kitchen",
    name: "Hot Kitchen Dashboard",
    purpose: "Hot kitchen queue and preparation performance.",
    scopeHint: "Station",
    widgets: STATION_WIDGETS("hot kitchen"),
    quickActions: STATION_ACTIONS,
  },
  pastry: {
    key: "pastry",
    name: "Pastry Dashboard",
    purpose: "Pastry queue, special orders and deadlines.",
    scopeHint: "Station",
    widgets: [
      ...STATION_WIDGETS("pastry"),
      fact("production-batches", "Items in preparation", "ops.kitchen.items_preparing"),
    ],
    quickActions: STATION_ACTIONS,
  },
  housekeeping: {
    key: "housekeeping",
    name: "Housekeeping Dashboard",
    purpose: "Room readiness, inspections and housekeeping tasks.",
    scopeHint: "Department",
    widgets: [
      // Department-wide readiness belongs to whoever runs the board; a cleaner
      // sees their own work instead of a row of refusals.
      fact("dirty-rooms", "Dirty rooms", "ops.housekeeping.dirty_rooms", { requires: HK_BOARD }),
      fact("cleaning", "Cleaning in progress", "ops.housekeeping.cleaning_in_progress", {
        requires: HK_BOARD,
      }),
      fact("ready-rooms", "Ready rooms", "ops.housekeeping.ready_rooms", { requires: HK_BOARD }),
      fact("inspection", "Rooms awaiting inspection", "ops.housekeeping.awaiting_inspection", {
        requires: HK_BOARD,
      }),
      fact("my-jobs", "My open jobs", "ops.housekeeping.my_open_jobs", { requires: HK_ASSIGNED }),
      // The authoritative cleaning workload is a housekeeping job, counted
      // above. The rows below are the department's general task list — notes,
      // follow-ups and cross-module work — so they are labelled as such rather
      // than competing with the cleaning figures.
      fact("open-jobs", "Open housekeeping jobs", "ops.housekeeping.open_jobs", {
        requires: HK_BOARD,
      }),
      kpi("open-tasks", "Open department tasks", "tasks.open"),
      kpi("overdue-tasks", "Overdue department tasks", "tasks.overdue", { tone: "warning" }),
      kpi("unassigned", "Unassigned department tasks", "tasks.unassigned", { requires: HK_BOARD }),
      kpi("completion", "Task completion rate", "tasks.completion_rate", {
        suffix: "%",
        requires: HK_BOARD,
      }),
      { ...panel("team-tasks", "Housekeeping assignments", "team-tasks", 2), requires: HK_BOARD },
      panel("notifications", "Housekeeping notifications", "notifications"),
      panel("my-tasks", "My tasks", "my-tasks"),
    ],
    quickActions: [
      { label: "My housekeeping work", to: "/housekeeping/my-work", requires: HK_ASSIGNED },
      {
        label: "Assign cleaner",
        to: "/housekeeping/board",
        requires: { module: "housekeeping", feature: "tasks", action: "assign" },
      },
      {
        label: "Start cleaning task",
        to: "/housekeeping/my-work",
        requires: { module: "housekeeping", feature: "cleaning", action: "start" },
      },
      {
        label: "Request supplies",
        to: "/housekeeping/requisitions",
        requires: { module: "housekeeping", feature: "requisitions", action: "create" },
      },
      {
        label: "Report maintenance issue",
        to: "/tasks",
        requires: { module: "maintenance", feature: "work-orders", action: "create" },
      },
      {
        label: "Housekeeping workspace",
        to: "/housekeeping",
        requires: { module: "housekeeping", feature: "overview", action: "view" },
      },
      {
        label: "Lost and found",
        to: "/housekeeping/lost-found",
        requires: { module: "housekeeping", feature: "lost-found", action: "manage" },
      },
    ],
  },
  procurement: {
    key: "procurement",
    name: "Procurement Dashboard",
    purpose: "Sourcing, purchase requests and supplier activity.",
    scopeHint: "Department",
    widgets: [
      kpi("purchase-approvals", "Purchase approvals pending", "approvals.pending", {
        tone: "accent",
      }),
      kpi("delayed-approvals", "Approvals delayed > 24 h", "approvals.delayed", {
        tone: "warning",
      }),
      kpi("open-tasks", "Open procurement tasks", "tasks.open"),
      kpi("overdue-tasks", "Overdue tasks", "tasks.overdue", { tone: "warning" }),
      fact("open-requests", "Open purchase requests", "ops.procurement.open_requests"),
      fact("purchase-orders", "Open purchase orders", "ops.procurement.open_orders"),
      fact("order-value", "Open order value", "ops.procurement.order_value_open"),
      fact("awaiting-receipt", "Goods awaiting receipt", "ops.procurement.awaiting_receipt"),
      fact("lead-time", "Procurement lead time", "ops.procurement.lead_time_days"),
      fact("suppliers", "Active suppliers", "ops.procurement.active_suppliers"),
      panel("approvals", "Purchase requests", "approvals", 2),
      panel("my-tasks", "My procurement tasks", "my-tasks"),
      panel("notifications", "Procurement notifications", "notifications"),
    ],
    quickActions: [
      { label: "Create purchase request", to: "/approvals" },
      { label: "Procurement workspace", to: "/procurement" },
      { label: "Create task", to: "/tasks" },
      { label: "Purchase requests", to: "/procurement/requests" },
      { label: "Purchase orders", to: "/procurement" },
    ],
  },
  stores: {
    key: "stores",
    name: "Inventory & Stores Dashboard",
    purpose: "Stock control, receiving and departmental issues.",
    scopeHint: "Department",
    widgets: [
      fact("low-stock", "Low-stock items", "ops.inventory.low_stock", { tone: "warning" }),
      fact("awaiting-receipt", "Goods awaiting receipt", "ops.procurement.awaiting_receipt"),
      fact("goods-received", "Goods received today", "ops.inventory.goods_received_today"),
      fact("valuation", "Stock valuation", "ops.inventory.valuation"),
      fact("variance", "Negative stock items", "ops.inventory.negative_stock", { tone: "warning" }),
      fact("expiring", "Expiring items", "ops.inventory.expiring_items"),
      kpi("adjustment-approvals", "Stock adjustment approvals", "approvals.pending", {
        tone: "accent",
      }),
      kpi("open-tasks", "Open stores tasks", "tasks.open"),
      kpi("overdue-tasks", "Overdue tasks", "tasks.overdue", { tone: "warning" }),
      panel("approvals", "Issue & adjustment requests", "approvals", 2),
      panel("my-tasks", "My stores tasks", "my-tasks"),
      panel("notifications", "Stores notifications", "notifications"),
    ],
    quickActions: [
      { label: "Request stock adjustment", to: "/approvals" },
      { label: "Inventory workspace", to: "/inventory" },
      { label: "Create task", to: "/tasks" },
      { label: "Receive goods", to: "/inventory/receiving" },
      { label: "Issue stock", to: "/inventory/issues" },
    ],
  },
  marketing: {
    key: "marketing",
    name: "Marketing Dashboard",
    purpose: "Campaigns, enquiries and guest engagement.",
    scopeHint: "Department",
    widgets: [
      fact("enquiries", "Open event enquiries", "ops.events.open_enquiries"),
      fact("new-guests", "New guest profiles today", "ops.crm.new_guests_today"),
      fact("reviews", "Feedback received today", "ops.crm.feedback_today"),
      fact("rating", "Average guest rating", "ops.crm.avg_rating"),
      fact("vip", "VIP guests", "ops.crm.vip_guests"),
      fact("campaigns", "Active campaigns", "ops.crm.active_campaigns"),
      kpi("open-tasks", "Open marketing tasks", "tasks.open"),
      kpi("overdue-tasks", "Overdue tasks", "tasks.overdue", { tone: "warning" }),
      kpi("campaign-approvals", "Campaign approvals", "approvals.pending", { tone: "accent" }),
      panel("team-tasks", "Campaign & social tasks", "team-tasks", 2),
      panel("approvals", "Campaign approvals", "approvals"),
      panel("notifications", "Marketing notifications", "notifications"),
    ],
    quickActions: [
      { label: "Create campaign task", to: "/tasks" },
      { label: "Create approval request", to: "/approvals" },
      { label: "Marketing workspace", to: "/marketing" },
      { label: "Guest profiles", to: "/crm/customers" },
      { label: "Campaigns", to: "/marketing/campaigns" },
    ],
  },
  events: {
    key: "events",
    name: "Events Dashboard",
    purpose: "Conferences, event readiness and department coordination.",
    scopeHint: "Department",
    widgets: [
      fact("upcoming", "Upcoming events", "ops.events.upcoming"),
      fact("today", "Events today", "ops.events.today"),
      fact("quotations", "Quotations sent", "ops.events.quotations_sent"),
      fact("confirmed", "Confirmed bookings", "ops.events.confirmed"),
      fact("deposits", "Deposits received", "ops.events.deposits_received"),
      fact("outstanding", "Outstanding balances", "ops.events.outstanding_balance", { tone: "warning" }),
      kpi("open-tasks", "Open event tasks", "tasks.open"),
      kpi("overdue-tasks", "Overdue tasks", "tasks.overdue", { tone: "warning" }),
      kpi("approvals", "Quotation approvals", "approvals.pending", { tone: "accent" }),
      panel("team-tasks", "Event tasks & department readiness", "team-tasks", 2),
      panel("approvals", "Event approval requests", "approvals"),
      panel("notifications", "Event notifications", "notifications"),
    ],
    quickActions: [
      { label: "Assign tasks", to: "/tasks" },
      { label: "Request quotation approval", to: "/approvals" },
      { label: "Events workspace", to: "/events" },
      { label: "Quotations", to: "/events/quotations" },
      { label: "Bookings", to: "/events/bookings" },
    ],
  },
  delivery: {
    key: "delivery",
    name: "Delivery Dashboard",
    purpose: "Delivery operations and rider activity.",
    scopeHint: "Department",
    widgets: [
      fact("incoming", "Incoming orders", "ops.delivery.incoming"),
      fact("preparing", "Orders in preparation", "ops.delivery.preparing"),
      fact("dispatched", "Orders dispatched", "ops.delivery.dispatched"),
      fact("unassigned", "Unassigned orders", "ops.delivery.unassigned", { tone: "warning" }),
      fact("delivered-today", "Delivered today", "ops.delivery.delivered_today"),
      fact("delivery-times", "Average delivery time", "ops.delivery.avg_delivery_minutes"),
      fact("delivery-revenue", "Delivery sales", "operational.delivery_sales"),
      fact("zones", "Delivery zones", "ops.delivery.zones"),
      fact("active-riders", "Riders on shift", "ops.delivery.riders_on_shift"),
      kpi("open-tasks", "Open delivery tasks", "tasks.open"),
      kpi("overdue-tasks", "Delayed / overdue tasks", "tasks.overdue", { tone: "warning" }),
      panel("team-tasks", "Delivery tasks", "team-tasks", 2),
      panel("alerts", "Delivery alerts", "alerts"),
      panel("notifications", "Delivery notifications", "notifications"),
    ],
    quickActions: [
      { label: "Assign task", to: "/tasks" },
      { label: "Escalate delayed delivery", to: "/approvals" },
      { label: "Delivery workspace", to: "/delivery" },
      { label: "Dispatch board", to: "/delivery" },
    ],
  },
  "human-resources": {
    key: "human-resources",
    name: "Human Resources Dashboard",
    purpose: "Staff operations with protected HR information.",
    scopeHint: "Department",
    widgets: [
      kpi("active-staff", "Active staff", "staff.active", { tone: "success" }),
      kpi("new-staff", "New employees in period", "staff.new_in_period"),
      kpi("invited", "Pending invitations", "staff.invited"),
      kpi("suspended", "Suspended accounts", "staff.suspended", { tone: "warning" }),
      kpi("hr-approvals", "HR approvals pending", "approvals.pending", { tone: "accent" }),
      fact("employees", "Employees on record", "ops.hr.active_employees"),
      fact("attendance", "Present today", "ops.hr.present_today"),
      fact("on-leave", "On leave today", "ops.hr.on_leave_today"),
      fact("leave-requests", "Leave requests pending", "ops.hr.open_leave_requests", { tone: "accent" }),
      fact("contracts", "Contracts expiring", "ops.hr.contracts_expiring", { tone: "warning" }),
      fact("probation", "Probation reviews due", "ops.hr.probation_due"),
      panel("approvals", "Leave & HR requests", "approvals", 2),
      panel("team-tasks", "Onboarding & training tasks", "team-tasks"),
      panel("notifications", "HR notifications", "notifications"),
    ],
    quickActions: [
      { label: "View employee records", to: "/users" },
      { label: "Approve leave", to: "/approvals" },
      { label: "Create onboarding task", to: "/tasks" },
      { label: "HR workspace", to: "/hr" },
      { label: "Shift scheduling", to: "/hr/scheduling" },
    ],
  },
  maintenance: {
    key: "maintenance",
    name: "Maintenance Dashboard",
    purpose: "Maintenance requests, work orders and escalations.",
    scopeHint: "Department",
    widgets: [
      kpi("new-requests", "Open maintenance tasks", "tasks.open"),
      kpi("in-progress", "Repairs in progress", "tasks.in_progress"),
      kpi("overdue", "Overdue repairs", "tasks.overdue", { tone: "warning" }),
      kpi("completed", "Completed repairs", "tasks.completed", { tone: "success" }),
      kpi("unassigned", "Unassigned requests", "tasks.unassigned"),
      kpi("completion", "Task completion rate", "tasks.completion_rate", { suffix: "%" }),
      fact("work-orders", "Open work orders", "ops.maintenance.open_work_orders"),
      fact("ooo-rooms", "Rooms blocked by maintenance", "ops.maintenance.rooms_blocked", { tone: "warning" }),
      fact("completed-today", "Repairs completed today", "ops.maintenance.completed_today", { tone: "success" }),
      fact("preventive", "Preventive maintenance due", "ops.maintenance.preventive_due"),
      panel("team-tasks", "Work queue", "team-tasks", 2),
      panel("my-tasks", "My assignments", "my-tasks"),
      panel("alerts", "Escalations", "alerts"),
      panel("notifications", "Maintenance notifications", "notifications"),
    ],
    quickActions: [
      { label: "Accept maintenance task", to: "/tasks" },
      { label: "Assign officer", to: "/tasks" },
      { label: "Request parts", to: "/approvals" },
      { label: "Escalate issue", to: "/approvals" },
      { label: "Maintenance workspace", to: "/maintenance" },
    ],
  },
  "ai-executive": {
    key: "ai-executive",
    name: "AI Executive Dashboard",
    purpose: "AI-generated management insights from authorised organisation data.",
    scopeHint: "Organisation",
    widgets: [
      panel("ai-summary", "AI executive summary", "ai-summary", 3),
      kpi("open-tasks", "Open tasks", "tasks.open"),
      kpi("overdue-tasks", "Overdue tasks", "tasks.overdue", { tone: "warning" }),
      kpi("pending-approvals", "Pending approvals", "approvals.pending", { tone: "accent" }),
      kpi("turnaround", "Approval turnaround", "approvals.avg_turnaround_hours", { suffix: " h" }),
      panel("kpi-catalogue", "Data sources & KPI definitions", "kpi-catalogue", 2),
      panel("alerts", "High-risk alerts", "alerts"),
    ],
    quickActions: [
      { label: "Full AI workspace", to: "/ai-insights" },
      { label: "Reports", to: "/reports" },
      { label: "Approvals", to: "/approvals" },
    ],
  },
};

export const FALLBACK_DASHBOARD: DashboardSpec = {
  key: "staff",
  name: "My Workspace",
  purpose: "Your assigned tasks, approvals and notifications.",
  scopeHint: "Personal",
  widgets: [
    kpi("my-open-tasks", "My open tasks", "tasks.mine_open"),
    kpi("my-overdue", "My overdue tasks", "tasks.mine_overdue", { tone: "warning" }),
    kpi("my-requests", "My pending requests", "approvals.mine_pending", { tone: "accent" }),
    kpi("unread", "Unread notifications", "notifications.unread"),
    panel("my-tasks", "My tasks", "my-tasks", 2),
    panel("notifications", "Notifications", "notifications"),
  ],
  quickActions: [
    { label: "My tasks", to: "/tasks" },
    { label: "Notifications", to: "/notifications" },
  ],
};

export function dashboardSpec(key: string | null | undefined): DashboardSpec {
  if (!key) return FALLBACK_DASHBOARD;
  return DASHBOARDS[key] ?? FALLBACK_DASHBOARD;
}

export function readMetric(metrics: unknown, path?: string): number | null {
  if (!metrics || !path) return null;
  let node: unknown = metrics;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "number" ? node : null;
}
