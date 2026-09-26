/**
 * Canonical scoped fact layer — the single client entry point.
 *
 * Dashboard, /analytics and /finance all read `neo_facts`. No page sums a
 * table on its own, so a figure cannot differ between screens. Scope
 * (organisation, property, period, currency, capability) is resolved in the
 * database; the branch and date arguments narrow the payload and can never
 * widen it.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/* eslint-disable @typescript-eslint/no-explicit-any */
const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase as any).rpc(fn, args) as Promise<{ data: any; error: { message: string } | null }>;

export type FactScope = {
  branchId: string | null;
  from: string | null;
  to: string | null;
};

export type FactPayload = Record<string, unknown>;

/** Dot-path read into the fact payload. */
export function factValue(facts: FactPayload | undefined, path: string): number | null {
  if (!facts) return null;
  let cur: unknown = facts;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur === null || cur === undefined || cur === "") return null;
  const n = Number(cur);
  return Number.isFinite(n) ? n : null;
}

export type FactKind =
  | "money"
  | "percent"
  | "count"
  | "nights"
  | "minutes"
  | "days"
  | "rating"
  | "ratio";

export type FactDefinition = {
  /** Metric path used by every consumer. Dashboards use the `facts.` prefix. */
  path: string;
  label: string;
  kind: FactKind;
  /** Plain-language rule explaining what qualifies for this fact. */
  eligibility: string;
  /** Operational records behind the fact. */
  drillTo: string;
};

/**
 * Named facts. Operational sales, forecast, invoiced value, collected cash and
 * posted accounting revenue are deliberately separate entries — they are
 * different things and are never added together.
 */
export const FACTS: Record<string, FactDefinition> = {
  "accounting.revenue_today": {
    path: "accounting.revenue_today",
    label: "Recognised revenue today",
    kind: "money",
    eligibility:
      "Posted folio charges, finalised point-of-sale orders and delivered delivery orders dated today in the property timezone, less reversals and credit notes.",
    drillTo: "/finance/journals",
  },
  "accounting.revenue_week": {
    path: "accounting.revenue_week",
    label: "Recognised revenue this week",
    kind: "money",
    eligibility: "Same rule as today, from the start of the property-local week.",
    drillTo: "/finance/journals",
  },
  "accounting.revenue_month": {
    path: "accounting.revenue_month",
    label: "Recognised revenue this month",
    kind: "money",
    eligibility: "Same rule as today, from the start of the property-local month.",
    drillTo: "/finance/journals",
  },
  "accounting.net_recognised_revenue": {
    path: "accounting.net_recognised_revenue",
    label: "Net recognised revenue",
    kind: "money",
    eligibility:
      "Posted folio charges plus finalised point-of-sale and delivered delivery sales in the selected period, less reversals and credit notes.",
    drillTo: "/finance/journals",
  },
  "accounting.posted_revenue": {
    path: "accounting.posted_revenue",
    label: "Posted accounting revenue",
    kind: "money",
    eligibility: "Revenue accounts on posted journal entries inside the period.",
    drillTo: "/finance/journals",
  },
  "accounting.cost_of_sales": {
    path: "accounting.cost_of_sales",
    label: "Cost of sales",
    kind: "money",
    eligibility:
      "Cost-of-sales accounts on posted journal entries inside the period. Unposted stock and purchase activity is never included.",
    drillTo: "/finance/journals",
  },
  "accounting.operating_expenses": {
    path: "accounting.operating_expenses",
    label: "Operating expenses",
    kind: "money",
    eligibility:
      "Operating and other expense accounts on posted journal entries inside the period, excluding cost of sales.",
    drillTo: "/finance/journals",
  },
  "accounting.gross_profit": {
    path: "accounting.gross_profit",
    label: "Gross profit",
    kind: "money",
    eligibility:
      "Posted accounting revenue less posted cost of sales. Blank until at least one of the two is posted.",
    drillTo: "/finance/journals",
  },
  "accounting.gross_margin": {
    path: "accounting.gross_margin",
    label: "Gross margin",
    kind: "percent",
    eligibility: "Gross profit as a share of posted accounting revenue.",
    drillTo: "/finance/journals",
  },
  "accounting.net_profit": {
    path: "accounting.net_profit",
    label: "Net profit",
    kind: "money",
    eligibility:
      "Posted accounting revenue less posted cost of sales and all posted operating and other expenses.",
    drillTo: "/finance/journals",
  },
  "accounting.net_margin": {
    path: "accounting.net_margin",
    label: "Net margin",
    kind: "percent",
    eligibility: "Net profit as a share of posted accounting revenue.",
    drillTo: "/finance/journals",
  },
  "accounting.payroll_cost": {
    path: "accounting.payroll_cost",
    label: "Payroll cost",
    kind: "money",
    eligibility:
      "Gross pay on approved, locked or posted payroll periods ending inside the reporting period. Draft payroll is excluded.",
    drillTo: "/finance/payroll-journal",
  },
  "payroll.employees_paid": {
    path: "payroll.employees_paid",
    label: "Employees on payroll",
    kind: "count",
    eligibility: "Distinct employees with a pay record in an approved payroll period in the range.",
    drillTo: "/finance/payroll-journal",
  },
  "inventory.closing_valuation": {
    path: "inventory.closing_valuation",
    label: "Stock value on hand",
    kind: "money",
    eligibility: "On-hand quantity × weighted average cost across active stock items.",
    drillTo: "/inventory",
  },
  "inventory.cost_of_issues": {
    path: "inventory.cost_of_issues",
    label: "Cost of stock used",
    kind: "money",
    eligibility:
      "Value of stock issued, consumed or wasted from the stock ledger inside the period. Transfers between stores are excluded.",
    drillTo: "/inventory/issues",
  },
  "inventory.stock_turnover": {
    path: "inventory.stock_turnover",
    label: "Stock turnover",
    kind: "ratio",
    eligibility:
      "Cost of stock used in the period ÷ stock value on hand. Blank while no stock value is recorded.",
    drillTo: "/inventory",
  },
  "inventory.days_on_hand": {
    path: "inventory.days_on_hand",
    label: "Days of stock on hand",
    kind: "days",
    eligibility: "Stock value on hand ÷ average daily cost of stock used in the period.",
    drillTo: "/inventory",
  },
  "rooms.occupancy_rate": {
    path: "rooms.occupancy_rate",
    label: "Occupancy rate",
    kind: "percent",
    eligibility:
      "Occupied room nights ÷ available room nights. Occupied nights come from stays that were checked in, in house, checked out or departed — not from reservations still on the books.",
    drillTo: "/pms/rooms",
  },
  "rooms.on_the_books_room_nights": {
    path: "rooms.on_the_books_room_nights",
    label: "Room nights on the books",
    kind: "nights",
    eligibility:
      "Confirmed, guaranteed and tentative reservations covering the period that have not yet checked in.",
    drillTo: "/pms/reservations",
  },
  "rooms.sellable_rooms": {
    path: "rooms.sellable_rooms",
    label: "Sellable rooms",
    kind: "count",
    eligibility: "Rooms flagged sellable in the selected property.",
    drillTo: "/pms/rooms",
  },
  "rooms.adr": {
    path: "rooms.adr",
    label: "Average daily rate",
    kind: "money",
    eligibility: "Posted room folio revenue ÷ occupied room nights.",
    drillTo: "/pms/rooms",
  },
  "rooms.revpar": {
    path: "rooms.revpar",
    label: "RevPAR",
    kind: "money",
    eligibility: "Posted room folio revenue ÷ available room nights.",
    drillTo: "/pms/rooms",
  },
  "operational.pos_finalised_sales": {
    path: "operational.pos_finalised_sales",
    label: "Finalised point-of-sale sales",
    kind: "money",
    eligibility:
      "Orders with status closed, paid, settled or completed. Draft, sent, ready and served orders are not revenue.",
    drillTo: "/pos/orders",
  },
  "operational.pos_open_value": {
    path: "operational.pos_open_value",
    label: "Open point-of-sale value",
    kind: "money",
    eligibility:
      "Value of orders still in service — draft, sent, ready or served. Operational value only, never counted as revenue.",
    drillTo: "/pos/orders",
  },
  "operational.delivery_sales": {
    path: "operational.delivery_sales",
    label: "Delivery sales",
    kind: "money",
    eligibility: "Delivery orders confirmed as delivered inside the period.",
    drillTo: "/delivery",
  },
  "operational.room_folio_revenue": {
    path: "operational.room_folio_revenue",
    label: "Room folio revenue",
    kind: "money",
    eligibility: "Posted accommodation folio charges inside the period.",
    drillTo: "/pms/folios",
  },
  "operational.other_folio_revenue": {
    path: "operational.other_folio_revenue",
    label: "Other posted folio charges",
    kind: "money",
    eligibility:
      "Posted non-accommodation folio charges — food and beverage, laundry, services — inside the period.",
    drillTo: "/pms/folios",
  },
  "events.confirmed_forecast": {
    path: "events.confirmed_forecast",
    label: "Confirmed event forecast",
    kind: "money",
    eligibility:
      "Contract value of confirmed and completed event bookings. Forecast only — it becomes revenue when invoiced or posted.",
    drillTo: "/events/bookings",
  },
  "events.provisional_forecast": {
    path: "events.provisional_forecast",
    label: "Provisional event forecast",
    kind: "money",
    eligibility: "Contract value of enquiries and provisional holds. Never accounting revenue.",
    drillTo: "/events/bookings",
  },
  "events.invoiced": {
    path: "events.invoiced",
    label: "Event value invoiced",
    kind: "money",
    eligibility: "Issued event invoices dated inside the period.",
    drillTo: "/finance/invoices",
  },
  "receivables.total": {
    path: "receivables.total",
    label: "Accounts receivable",
    kind: "money",
    eligibility:
      "Issued, partially paid and overdue invoices with a remaining balance, plus open folio balances.",
    drillTo: "/finance/receivables",
  },
  "receivables.invoices_overdue": {
    path: "receivables.invoices_overdue",
    label: "Receivables overdue",
    kind: "money",
    eligibility: "Outstanding invoice balances past their due date in the property timezone.",
    drillTo: "/finance/receivables",
  },
  "payables.total": {
    path: "payables.total",
    label: "Accounts payable",
    kind: "money",
    eligibility: "Approved supplier invoices that are neither paid nor cancelled.",
    drillTo: "/finance/payables",
  },
  "collections.total": {
    path: "collections.total",
    label: "Payments collected",
    kind: "money",
    eligibility: "Confirmed payment receipts dated inside the period in the property timezone.",
    drillTo: "/finance/payments",
  },
  "rooms.occupied_room_nights": {
    path: "rooms.occupied_room_nights",
    label: "Occupied room nights",
    kind: "nights",
    eligibility:
      "Nights from stays that were checked in, in house, checked out or departed inside the period.",
    drillTo: "/pms/rooms",
  },
  "rooms.available_room_nights": {
    path: "rooms.available_room_nights",
    label: "Sellable room nights",
    kind: "nights",
    eligibility:
      "Sellable rooms × nights in the period, less nights the room was out of order.",
    drillTo: "/pms/rooms",
  },
  /* Front office day figures — always the property-local operational date,
     independent of the reporting period selector. */
  "front_office.arrivals_today": {
    path: "front_office.arrivals_today",
    label: "Today's arrivals",
    kind: "count",
    eligibility:
      "Reservations arriving on the property-local date that are confirmed, guaranteed, held on deposit or already checked in.",
    drillTo: "/pms/arrivals",
  },
  "front_office.departures_today": {
    path: "front_office.departures_today",
    label: "Today's departures",
    kind: "count",
    eligibility:
      "Stays due to depart on the property-local date, whether still in house or already checked out.",
    drillTo: "/pms/departures",
  },
  "front_office.checkins_completed": {
    path: "front_office.checkins_completed",
    label: "Check-ins completed",
    kind: "count",
    eligibility:
      "Reservations arriving today that have been checked in (including any that have since departed).",
    drillTo: "/pms/arrivals",
  },
  "front_office.in_house": {
    path: "front_office.in_house",
    label: "Guests in house",
    kind: "count",
    eligibility: "Reservations currently in the checked-in state.",
    drillTo: "/pms/in-house",
  },
  "front_office.rooms_available": {
    path: "front_office.rooms_available",
    label: "Available rooms",
    kind: "count",
    eligibility:
      "Rooms sellable right now in the live room state: in service, not occupied, not blocked and ready for arrival.",
    drillTo: "/pms/rooms",
  },
  "front_office.rooms_occupied": {
    path: "front_office.rooms_occupied",
    label: "Occupied rooms",
    kind: "count",
    eligibility: "Rooms whose live occupancy state is occupied.",
    drillTo: "/pms/rooms",
  },
  "front_office.rooms_out_of_order": {
    path: "front_office.rooms_out_of_order",
    label: "Out of order rooms",
    kind: "count",
    eligibility: "Rooms withdrawn from inventory as out of order in the live room state.",
    drillTo: "/pms/rooms",
  },
  "front_office.rooms_dirty": {
    path: "front_office.rooms_dirty",
    label: "Rooms to clean",
    kind: "count",
    eligibility: "Rooms whose live condition is dirty and awaiting housekeeping.",
    drillTo: "/housekeeping/board",
  },
};

/**
 * Operational day facts — the property-local snapshot served by
 * `neo_operational_facts`. Every figure is resolved in the database under the
 * reader's own scope; the dashboard never recomputes one client-side.
 */
const ops = (
  path: string,
  label: string,
  kind: FactKind,
  eligibility: string,
  drillTo: string,
): FactDefinition => ({ path: `ops.${path}`, label, kind, eligibility, drillTo });

const OPERATIONAL_FACTS: FactDefinition[] = [
  // Kitchen (department-wide)
  ops("kitchen.new_items", "New kitchen items", "count", "Kitchen ticket items raised today that are still new, queued or sent.", "/kitchen/queue"),
  ops("kitchen.items_preparing", "Items in preparation", "count", "Kitchen ticket items accepted or being prepared right now.", "/kitchen/queue"),
  ops("kitchen.items_ready", "Ready items", "count", "Kitchen ticket items marked ready and awaiting collection.", "/kitchen/queue"),
  ops("kitchen.avg_prep_minutes", "Average preparation time", "minutes", "Mean minutes between a kitchen item being accepted and marked ready today.", "/kitchen/queue"),
  ops("kitchen.delayed_items", "Delayed items", "count", "Kitchen items past their station target time and still not ready.", "/kitchen/queue"),
  // Station (only the reader's own stations)
  ops("station.new_items", "New station items", "count", "New items routed to the stations assigned to the reader.", "/kitchen/queue"),
  ops("station.items_preparing", "Items in preparation", "count", "Items in preparation at the reader's own stations.", "/kitchen/queue"),
  ops("station.items_ready", "Ready items", "count", "Ready items at the reader's own stations.", "/kitchen/queue"),
  ops("station.avg_prep_minutes", "Average preparation time", "minutes", "Mean accepted-to-ready minutes at the reader's own stations today.", "/kitchen/queue"),
  // Restaurant (department-wide)
  ops("restaurant.active_tables", "Active tables", "count", "Distinct tables with an order still in service today.", "/pos/floor"),
  ops("restaurant.orders_in_progress", "Orders in progress", "count", "Orders opened today that are draft, sent, confirmed, preparing or partially served.", "/pos/orders"),
  ops("restaurant.orders_ready", "Orders ready", "count", "Orders whose items are ready for collection.", "/pos/orders"),
  ops("restaurant.open_bills", "Open bills", "count", "Orders opened today that are not yet settled, cancelled or voided.", "/pos/orders"),
  ops("restaurant.open_value", "Open bill value", "money", "Value of unsettled orders. Operational value only — never counted as revenue.", "/pos/orders"),
  ops("restaurant.sales_today", "Restaurant sales", "money", "Value of orders settled today (closed, paid, settled or completed).", "/pos/reports"),
  ops("restaurant.avg_service_minutes", "Average service time", "minutes", "Mean minutes between an order being sent to the kitchen and served.", "/pos/reports"),
  // Waiter (personal)
  ops("waiter.assigned_tables", "Assigned tables", "count", "Tables with an unsettled order where the reader is the waiter of record.", "/pos/floor"),
  ops("waiter.orders_awaiting_service", "Orders awaiting service", "count", "The reader's own orders still in preparation or partially served.", "/pos/orders"),
  ops("waiter.orders_ready", "Orders ready for collection", "count", "The reader's own orders marked ready by the kitchen.", "/pos/orders"),
  ops("waiter.open_bills", "My open bills", "count", "The reader's own unsettled orders.", "/pos/orders"),
  ops("waiter.service_delays", "Service delays", "count", "The reader's ready orders not collected within ten minutes.", "/pos/orders"),
  // Housekeeping
  ops("housekeeping.dirty_rooms", "Dirty rooms", "count", "Rooms whose live condition is dirty in the authoritative room state.", "/housekeeping/board"),
  ops("housekeeping.cleaning_in_progress", "Cleaning in progress", "count", "Housekeeping jobs currently started or in progress.", "/housekeeping/board"),
  ops("housekeeping.ready_rooms", "Ready rooms", "count", "Clean, unoccupied rooms in the authoritative room state.", "/housekeeping/board"),
  ops("housekeeping.awaiting_inspection", "Rooms awaiting inspection", "count", "Completed jobs that require inspection and have not yet passed.", "/housekeeping/inspections"),
  ops("housekeeping.open_jobs", "Open housekeeping jobs", "count", "Housekeeping jobs not completed, verified or cancelled.", "/housekeeping/board"),
  ops("housekeeping.my_open_jobs", "My open jobs", "count", "Open housekeeping jobs assigned to the reader.", "/housekeeping/tasks"),
  // Procurement
  ops("procurement.open_requests", "Open purchase requests", "count", "Purchase requests still in draft, submitted or pending approval.", "/procurement/requests"),
  ops("procurement.awaiting_approval", "Requests awaiting approval", "count", "Submitted purchase requests with no decision recorded.", "/procurement/requests"),
  ops("procurement.open_orders", "Open purchase orders", "count", "Purchase orders that are neither closed nor cancelled.", "/procurement"),
  ops("procurement.awaiting_receipt", "Goods awaiting receipt", "count", "Approved, sent or partially received purchase orders.", "/inventory/receiving"),
  ops("procurement.order_value_open", "Open order value", "money", "Total value of purchase orders still open.", "/procurement"),
  ops("procurement.lead_time_days", "Procurement lead time", "days", "Mean days between approving a purchase order and closing it.", "/procurement"),
  ops("procurement.active_suppliers", "Active suppliers", "count", "Suppliers marked active for the property.", "/procurement"),
  // Inventory / stores
  ops("inventory.low_stock", "Low-stock items", "count", "Active stock items whose on-hand quantity is at or below their minimum level.", "/inventory"),
  ops("inventory.negative_stock", "Negative stock items", "count", "Active stock items with a negative on-hand balance — a counting or posting fault.", "/inventory"),
  ops("inventory.valuation", "Stock valuation", "money", "On-hand quantity × weighted average cost across active stock items.", "/inventory"),
  ops("inventory.goods_received_today", "Goods received today", "count", "Goods receipts recorded on the property-local date.", "/inventory/receiving"),
  ops("inventory.expiring_items", "Expiring items", "count", "Stock batches with remaining quantity expiring within 30 days.", "/inventory"),
  // Events
  ops("events.upcoming", "Upcoming events", "count", "Confirmed, tentative and provisional bookings dated today or later.", "/events/bookings"),
  ops("events.confirmed", "Confirmed bookings", "count", "Event bookings in the confirmed state.", "/events/bookings"),
  ops("events.today", "Events today", "count", "Non-cancelled bookings dated on the property-local date.", "/events/calendar"),
  ops("events.deposits_received", "Deposits received", "money", "Amounts already paid against event bookings.", "/events/billing"),
  ops("events.outstanding_balance", "Outstanding balances", "money", "Contract value not yet paid across event bookings.", "/events/billing"),
  ops("events.quotations_sent", "Quotations sent", "count", "Event quotations sent, viewed or pending decision.", "/events/quotations"),
  ops("events.open_enquiries", "Open enquiries", "count", "Event enquiries still being worked.", "/events/enquiries"),
  // Delivery
  ops("delivery.incoming", "Incoming orders", "count", "Delivery orders placed, pending or accepted and not yet in preparation.", "/delivery"),
  ops("delivery.preparing", "Orders in preparation", "count", "Delivery orders being prepared or ready for pickup.", "/delivery"),
  ops("delivery.dispatched", "Orders dispatched", "count", "Delivery orders collected by a rider or out for delivery.", "/delivery"),
  ops("delivery.delivered_today", "Delivered today", "count", "Delivery orders confirmed delivered on the property-local date.", "/delivery"),
  ops("delivery.unassigned", "Unassigned orders", "count", "Live delivery orders with no rider assigned.", "/delivery"),
  ops("delivery.avg_delivery_minutes", "Average delivery time", "minutes", "Mean minutes between rider acceptance and delivery confirmation.", "/delivery"),
  ops("delivery.sales_today", "Delivery sales today", "money", "Value of delivery orders confirmed delivered today.", "/delivery"),
  ops("delivery.riders_on_shift", "Riders on shift", "count", "Riders with an active shift covering the current time.", "/delivery"),
  ops("delivery.zones", "Delivery zones", "count", "Configured delivery zones for the property.", "/delivery"),
  // People
  ops("hr.active_employees", "Active employees", "count", "Employee records that are not terminated, exited or resigned.", "/hr/employees"),
  ops("hr.present_today", "Present today", "count", "Employees with a clock-in recorded for the property-local date.", "/hr/attendance"),
  ops("hr.on_leave_today", "On leave today", "count", "Approved leave requests covering the property-local date.", "/hr/leave"),
  ops("hr.open_leave_requests", "Leave requests pending", "count", "Leave requests submitted and awaiting a decision.", "/hr/leave"),
  ops("hr.contracts_expiring", "Contracts expiring", "count", "Employment contracts ending within 60 days.", "/hr/employees"),
  ops("hr.probation_due", "Probation reviews due", "count", "Probation periods ending within 30 days.", "/hr/performance"),
  // Maintenance
  ops("maintenance.open_work_orders", "Open work orders", "count", "Maintenance work orders not completed, closed or cancelled.", "/maintenance"),
  ops("maintenance.in_progress", "Repairs in progress", "count", "Work orders assigned, accepted or in progress.", "/maintenance"),
  ops("maintenance.rooms_blocked", "Rooms blocked by maintenance", "count", "Live work orders that block the room from sale.", "/maintenance"),
  ops("maintenance.completed_today", "Completed today", "count", "Work orders completed on the property-local date.", "/maintenance"),
  ops("maintenance.preventive_due", "Preventive maintenance due", "count", "Scheduled preventive occurrences due within seven days.", "/maintenance"),
  // Laundry
  ops("laundry.open_orders", "Open laundry orders", "count", "Guest laundry orders not delivered, closed or cancelled.", "/laundry"),
  ops("laundry.due_today", "Due today", "count", "Open laundry orders with a required delivery time today.", "/laundry"),
  ops("laundry.delivered_today", "Delivered today", "count", "Laundry orders returned to the guest today.", "/laundry"),
  ops("laundry.unposted_charges", "Unposted laundry charges", "count", "Laundry orders whose charge has not reached a folio.", "/laundry"),
  // Guests / CRM
  ops("crm.new_guests_today", "New guest profiles", "count", "Guest profiles created on the property-local date.", "/crm/customers"),
  ops("crm.vip_guests", "VIP guests", "count", "Active guest profiles flagged VIP.", "/crm/customers"),
  ops("crm.open_feedback", "Open feedback", "count", "Guest feedback records not yet resolved or closed.", "/crm/feedback"),
  ops("crm.feedback_today", "Feedback received today", "count", "Guest feedback received on the property-local date.", "/crm/feedback"),
  ops("crm.avg_rating", "Average guest rating", "rating", "Mean rating across guest feedback in scope.", "/crm/feedback"),
  ops("crm.active_campaigns", "Active campaigns", "count", "Marketing campaigns running, scheduled or launched.", "/marketing/campaigns"),
  // Cash & shifts
  ops("finance.open_shifts", "Open cash shifts", "count", "Point-of-sale shifts still open.", "/pos/shifts"),
  ops("finance.shifts_awaiting_review", "Shifts awaiting review", "count", "Closed shifts with no supervisor review recorded.", "/pos/shifts"),
  ops("finance.cash_variance_today", "Cash variance today", "money", "Sum of counted-versus-expected variance on shifts closed today.", "/finance/banking"),
  ops("finance.cash_expected_open", "Expected cash in open shifts", "money", "Expected drawer balance across shifts still open.", "/pos/shifts"),
  ops("finance.payments_today", "Payments collected today", "money", "Confirmed payment receipts dated on the property-local date.", "/finance/banking"),
];

for (const def of OPERATIONAL_FACTS) FACTS[def.path] = def;

/** Fact paths served by `neo_operational_facts` rather than `neo_facts`. */
export const OPERATIONAL_FACT_PREFIX = "ops.";

export const factDefinition = (path: string): FactDefinition | undefined => FACTS[path];

/** Metric ids used on role dashboards carry a `facts.` prefix. */
export const FACT_METRIC_PREFIX = "facts.";
export const isFactMetric = (metric?: string): boolean =>
  Boolean(metric && metric.startsWith(FACT_METRIC_PREFIX));
export const factPathOf = (metric: string): string => metric.slice(FACT_METRIC_PREFIX.length);

/* ------------------------------------------------------------------ *
 * Independent fact domains
 *
 * The three scoped reads behind a dashboard are separate query domains with
 * separate cache entries, loading flags and errors. A failure in one domain
 * (say the accounting period guard) can no longer blank unrelated Front Office
 * or operational cards — each card reads the state of its own domain only.
 * ------------------------------------------------------------------ */

export type FactDomain = "period" | "front_office" | "operational";

export const FACT_DOMAIN_SERVICE: Record<FactDomain, string> = {
  period: "neo_facts",
  front_office: "neo_front_office_facts",
  operational: "neo_operational_facts",
};

export const FACT_DOMAIN_LABEL: Record<FactDomain, string> = {
  period: "Period & accounting facts",
  front_office: "Front Office facts",
  operational: "Operational facts",
};

/** Which service owns a fact path. */
export const factDomainOf = (path: string): FactDomain =>
  path.startsWith("front_office.")
    ? "front_office"
    : path.startsWith(OPERATIONAL_FACT_PREFIX)
      ? "operational"
      : "period";

export type FactFailureKind =
  | "property-required"
  | "session-required"
  | "access-denied"
  | "invalid-period"
  | "source-error";

export type FactFailure = {
  domain: FactDomain;
  service: string;
  kind: FactFailureKind;
  /** Plain-language explanation shown to the reader. */
  message: string;
  /** Raw database message, kept for diagnostics. */
  detail: string;
};

const FAILURE_COPY: Record<FactFailureKind, string> = {
  "property-required": "Select a property — your access does not cover the whole organisation.",
  "session-required":
    "Your staff session could not be resolved. Sign in again or ask an administrator to confirm your employment record.",
  "access-denied": "You are not authorised to read these figures for the selected property.",
  "invalid-period": "The selected reporting period is not valid for this service.",
  "source-error": "The service could not be read. Retry, or report the problem if it persists.",
};

/** Turns a raw database error into an explainable, domain-tagged failure. */
export function classifyFactError(error: unknown, domain: FactDomain): FactFailure | null {
  if (!error) return null;
  const detail =
    typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message ?? "")
      : String(error);
  const raw = detail.toLowerCase();
  const kind: FactFailureKind = raw.includes("explicit_property_required_for_scoped_user")
    ? "property-required"
    : raw.includes("reporting_session_required") || raw.includes("no_organisation")
      ? "session-required"
      : raw.includes("property_out_of_scope") ||
          raw.includes("outside your access scope") ||
          raw.includes("permission denied") ||
          raw.includes("row-level security")
        ? "access-denied"
        : raw.includes("invalid_report_period") || raw.includes("report_period_too_large")
          ? "invalid-period"
          : "source-error";
  return {
    domain,
    service: FACT_DOMAIN_SERVICE[domain],
    kind,
    message: FAILURE_COPY[kind],
    detail,
  };
}

export type FactDomainState = {
  domain: FactDomain;
  service: string;
  data: FactPayload | undefined;
  isLoading: boolean;
  isSuccess: boolean;
  isFetching: boolean;
  error: unknown;
  failure: FactFailure | null;
  /** True when a property must be chosen before this domain can answer. */
  scopeSelectionRequired: boolean;
  refetch: () => void;
};

export type FactsResult = {
  /** Merged payload of the domains that answered. Never partially invented. */
  data: FactPayload | undefined;
  isLoading: boolean;
  isSuccess: boolean;
  isFetching: boolean;
  /** Set only when every domain failed, so one broken domain never blanks all. */
  error: unknown;
  refetch: () => void;
  domains: Record<FactDomain, FactDomainState>;
  failures: FactFailure[];
  /** State of the single domain that owns a fact path. */
  forPath: (path: string) => FactDomainState;
};

function useFactDomain(domain: FactDomain, scope: FactScope, enabled: boolean) {
  const args =
    domain === "period"
      ? { _branch: scope.branchId, _from: scope.from, _to: scope.to }
      : { _branch: scope.branchId };
  const query = useQuery({
    queryKey:
      domain === "period"
        ? ["neo-facts", "period", scope.branchId, scope.from, scope.to]
        : ["neo-facts", domain, scope.branchId],
    enabled,
    refetchInterval: 60_000,
    // A scope refusal is an answer, not a transient fault — retrying it only
    // multiplies identical failures across every card on the page.
    retry: (count, error) => {
      const failure = classifyFactError(error, domain);
      if (failure && failure.kind !== "source-error") return false;
      return count < 1;
    },
    queryFn: async (): Promise<FactPayload> => {
      const { data, error } = await rpc(FACT_DOMAIN_SERVICE[domain], args);
      if (error) throw new Error(error.message);
      return (data ?? {}) as FactPayload;
    },
  });
  const failure = classifyFactError(query.error, domain);
  const state: FactDomainState = {
    domain,
    service: FACT_DOMAIN_SERVICE[domain],
    data: query.data,
    isLoading: enabled && query.isLoading,
    isSuccess: query.isSuccess,
    isFetching: query.isFetching,
    error: query.error,
    failure,
    scopeSelectionRequired: failure?.kind === "property-required",
    refetch: () => void query.refetch(),
  };
  return state;
}

/**
 * The canonical fact reader. Three independent query domains, merged for
 * convenience but never coupled: each card, panel and status line reads the
 * loading and error state of the one domain that produces its figure.
 */
export function useFacts(scope: FactScope, enabled = true): FactsResult {
  const period = useFactDomain("period", scope, enabled);
  const frontOffice = useFactDomain("front_office", scope, enabled);
  const operational = useFactDomain("operational", scope, enabled);

  const domains: Record<FactDomain, FactDomainState> = {
    period,
    front_office: frontOffice,
    operational,
  };
  const list = [period, frontOffice, operational];
  const answered = list.filter((d) => d.isSuccess);

  const data: FactPayload | undefined = answered.length
    ? ({
        ...((period.data ?? {}) as FactPayload),
        ...(frontOffice.isSuccess ? { front_office: frontOffice.data ?? {} } : {}),
        ...(operational.isSuccess ? { ops: operational.data ?? {} } : {}),
      } as FactPayload)
    : undefined;

  const failures = list
    .map((d) => d.failure)
    .filter((f): f is FactFailure => Boolean(f));

  return {
    data,
    isLoading: list.every((d) => d.isLoading),
    isSuccess: answered.length > 0,
    isFetching: list.some((d) => d.isFetching),
    error: failures.length === list.length ? period.error : null,
    refetch: () => list.forEach((d) => d.refetch()),
    domains,
    failures,
    forPath: (path: string) => domains[factDomainOf(path)],
  };
}



export type ReconciliationRow = {
  stream: string;
  operational_eligible: number;
  posted: number;
  reversals: number;
  net_recognised: number;
  collected: number;
  outstanding_receivable: number;
  unmatched_records: number;
};

export function useFactReconciliation(scope: FactScope, enabled = true) {
  return useQuery({
    queryKey: ["neo-facts", "reconciliation", scope.branchId, scope.from, scope.to],
    enabled,
    queryFn: async (): Promise<ReconciliationRow[]> => {
      const { data, error } = await rpc("neo_fact_reconciliation", {
        _branch: scope.branchId,
        _from: scope.from,
        _to: scope.to,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as ReconciliationRow[];
    },
  });
}

export type UnmatchedRow = {
  source_module: string;
  source_id: string;
  reference: string;
  status: string;
  amount: number;
  occurred_on: string;
  reason: string;
  drill_to: string;
};

export function useUnmatchedFacts(scope: FactScope, enabled = true) {
  return useQuery({
    queryKey: ["neo-facts", "unmatched", scope.branchId, scope.from, scope.to],
    enabled,
    queryFn: async (): Promise<UnmatchedRow[]> => {
      const { data, error } = await rpc("neo_unmatched_facts", {
        _branch: scope.branchId,
        _from: scope.from,
        _to: scope.to,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as UnmatchedRow[];
    },
  });
}

/** Formats a fact for display without ever inventing a value. */
export function formatFact(value: number | null, kind: FactKind, currency = ""): string {
  if (value === null) return "—";
  if (kind === "percent") return `${value.toFixed(1)}%`;
  if (kind === "count" || kind === "nights") return String(Math.round(value));
  if (kind === "minutes") return `${value.toFixed(1)} min`;
  if (kind === "days") return `${value.toFixed(1)} d`;
  if (kind === "rating") return value.toFixed(2);
  if (kind === "ratio") return `${value.toFixed(2)}×`;
  const amount = new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(value);
  return currency ? `${currency} ${amount}` : amount;
}

export const factPeriodLabel = (facts: FactPayload | undefined): string => {
  const period = (facts?.["period"] ?? {}) as Record<string, unknown>;
  return period["from"] && period["to"] ? `${period["from"]} → ${period["to"]}` : "—";
};

export type PosLifecycleRow = { lifecycle: string; orders: number; value: number };

export type FactSupplement = {
  authorised: boolean;
  monetary_authorised: boolean;
  pos_open_by_lifecycle: PosLifecycleRow[];
  rooms: { blocked_rooms: number; out_of_service_rooms: number };
  handoff: {
    unmatched_eligible: number;
    unmatched_eligible_value: number;
    posted_journals: number;
  };
};

/**
 * Explains the headline facts: which lifecycle the open point-of-sale value
 * sits in, how much room inventory is blocked, and how many already-eligible
 * transactions have not reached Finance.
 */
export function useFactSupplement(scope: FactScope, enabled = true) {
  return useQuery({
    queryKey: ["neo-facts", "supplement", scope.branchId, scope.from, scope.to],
    enabled,
    queryFn: async (): Promise<FactSupplement> => {
      const { data, error } = await rpc("neo_fact_supplement", {
        _branch: scope.branchId,
        _from: scope.from,
        _to: scope.to,
      });
      if (error) throw new Error(error.message);
      return data as FactSupplement;
    },
  });
}

export const factGeneratedAt = (facts: FactPayload | undefined): string | null =>
  (facts?.["generated_at"] as string | undefined) ?? null;


export const factCurrency = (facts: FactPayload | undefined): string =>
  ((facts?.["scope"] as Record<string, unknown> | undefined)?.["currency"] as string) ?? "";

export const factTimezone = (facts: FactPayload | undefined): string =>
  ((facts?.["scope"] as Record<string, unknown> | undefined)?.["timezone"] as string) ?? "";

export const factsAuthorised = (facts: FactPayload | undefined): boolean =>
  facts ? facts["authorised"] !== false : true;

export const factsMonetaryAuthorised = (facts: FactPayload | undefined): boolean =>
  facts ? facts["monetary_authorised"] === true : false;
