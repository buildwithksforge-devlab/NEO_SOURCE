/**
 * Phase 16 — Intelligence, Business Intelligence & Advanced Analytics.
 *
 * This module is the single vocabulary for the analytics layer:
 *  - the KPI catalogue (definition, formula, sources, scope, governance status)
 *  - deterministic forecasting used when no AI provider is configured
 *  - deterministic, explainable advisory recommendations
 *  - the allowlisted semantic layer the AI assistant is permitted to answer from
 *
 * Nothing here invents data. Every value shown in the UI originates from a
 * permission-checked database function (`bi_*`) that scopes to the signed-in
 * user's organisation server-side.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;

/* ================================================================== *
 * Metric governance
 * ================================================================== */

export const METRIC_STATUSES = ["draft", "under_review", "approved", "active", "deprecated"] as const;
export type MetricStatus = (typeof METRIC_STATUSES)[number];

export const FRESHNESS_CLASSES = [
  "realtime",
  "near_realtime",
  "hourly",
  "daily",
  "scheduled",
  "delayed",
  "refresh_failed",
] as const;
export type FreshnessClass = (typeof FRESHNESS_CLASSES)[number];

export const freshnessLabels: Record<FreshnessClass, string> = {
  realtime: "Realtime",
  near_realtime: "Near realtime",
  hourly: "Hourly",
  daily: "Daily",
  scheduled: "Scheduled",
  delayed: "Delayed",
  refresh_failed: "Refresh failed",
};

export type MetricUnit = "currency" | "percent" | "number" | "hours" | "minutes" | "nights";

export type MetricDefinition = {
  code: string;
  name: string;
  description: string;
  businessMeaning: string;
  formula: string;
  numerator: string;
  denominator: string;
  includedRecords: string;
  excludedRecords: string;
  sources: string[];
  dateField: string;
  currencyTreatment: string;
  scope: string;
  refresh: FreshnessClass;
  owner: string;
  version: number;
  effectiveDate: string;
  status: MetricStatus;
  unit: MetricUnit;
  /** Dot path into the `bi_kpis()` result. */
  path: string;
  section: AnalyticsSectionKey;
};

export type AnalyticsSectionKey =
  | "executive"
  | "rooms"
  | "restaurant"
  | "kitchen"
  | "inventory"
  | "procurement"
  | "finance"
  | "customers"
  | "marketing"
  | "workforce"
  | "events"
  | "operations"
  | "delivery";

const ORG_SCOPE = "Organisation → branch → department, enforced by RLS and bi_* functions";
const TZ_NOTE = "Property timezone from Regional Configuration";

/** The approved KPI catalogue. Dashboards may only render metrics from here. */
export const METRIC_CATALOGUE: MetricDefinition[] = [
  {
    code: "occupancy_rate",
    name: "Occupancy Rate",
    description: "Share of sellable room nights that were occupied in the period.",
    businessMeaning: "How well the property converted available inventory into occupied rooms.",
    formula: "Occupied room nights ÷ Available room nights × 100",
    numerator: "Room nights from reservations in checked-in, in-house, checked-out or departed status",
    denominator: "Sellable rooms × nights in period, less out-of-order room nights",
    includedRecords: "Reservations that physically occupied a room during the period",
    excludedRecords: "Cancellations, no-shows and out-of-order rooms (removed from available inventory)",
    sources: ["reservations", "rooms"],
    dateField: "reservations.arrival_date / departure_date overlap",
    currencyTreatment: "Not applicable",
    scope: ORG_SCOPE,
    refresh: "near_realtime",
    owner: "General Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "percent",
    path: "rooms.occupancy_rate",
    section: "rooms",
  },
  {
    code: "adr",
    name: "ADR — Average Daily Rate",
    description: "Average room revenue earned per occupied room night.",
    businessMeaning: "Pricing strength of rooms actually sold.",
    formula: "Eligible room revenue ÷ Rooms sold (occupied room nights)",
    numerator: "Posted folio lines classified as room revenue",
    denominator: "Occupied room nights",
    includedRecords: "Room charges on live folios",
    excludedRecords: "Taxes, non-room revenue, voided lines and complimentary rooms",
    sources: ["folio_lines", "reservations"],
    dateField: "folio_lines.operational_date",
    currencyTreatment: "Property base currency, net of tax",
    scope: ORG_SCOPE,
    refresh: "near_realtime",
    owner: "Front Office Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "currency",
    path: "rooms.adr",
    section: "rooms",
  },
  {
    code: "revpar",
    name: "RevPAR — Revenue per Available Room",
    description: "Room revenue earned per available room night.",
    businessMeaning: "Combined effect of rate and occupancy on room inventory.",
    formula: "Eligible room revenue ÷ Available room nights (verify: ADR × Occupancy Rate)",
    numerator: "Posted room revenue",
    denominator: "Available room nights",
    includedRecords: "Same inclusions as ADR",
    excludedRecords: "Out-of-order room nights",
    sources: ["folio_lines", "rooms"],
    dateField: "folio_lines.operational_date",
    currencyTreatment: "Property base currency, net of tax",
    scope: ORG_SCOPE,
    refresh: "near_realtime",
    owner: "General Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "currency",
    path: "rooms.revpar",
    section: "rooms",
  },
  {
    code: "alos",
    name: "Average Length of Stay",
    description: "Average number of nights per completed stay.",
    businessMeaning: "Booking depth; longer stays reduce turnover cost.",
    formula: "Total occupied room nights ÷ Completed stays",
    numerator: "Occupied room nights",
    denominator: "Reservations that departed in the period",
    includedRecords: "Checked-out and departed reservations",
    excludedRecords: "In-house stays not yet completed",
    sources: ["reservations"],
    dateField: "reservations.departure_date",
    currencyTreatment: "Not applicable",
    scope: ORG_SCOPE,
    refresh: "daily",
    owner: "Front Office Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "nights",
    path: "rooms.alos",
    section: "rooms",
  },
  {
    code: "cancellation_rate",
    name: "Cancellation Rate",
    description: "Share of eligible reservations cancelled.",
    businessMeaning: "Demand reliability and booking quality.",
    formula: "Cancelled eligible reservations ÷ Total eligible reservations × 100",
    numerator: "Reservations with status cancelled arriving in the period",
    denominator: "All reservations arriving in the period",
    includedRecords: "Reservations with an arrival date inside the period",
    excludedRecords: "Enquiries and waitlist entries that never became reservations",
    sources: ["reservations"],
    dateField: "reservations.arrival_date",
    currencyTreatment: "Not applicable",
    scope: ORG_SCOPE,
    refresh: "daily",
    owner: "Front Office Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "percent",
    path: "rooms.cancellation_rate",
    section: "rooms",
  },
  {
    code: "no_show_rate",
    name: "No-Show Rate",
    description: "Share of eligible reservations recorded as no-show.",
    businessMeaning: "Revenue lost from guaranteed arrivals that never arrived.",
    formula: "No-show reservations ÷ Total eligible reservations × 100",
    numerator: "Reservations with status no_show",
    denominator: "All reservations arriving in the period",
    includedRecords: "Reservations arriving in the period",
    excludedRecords: "Cancellations made before arrival day",
    sources: ["reservations"],
    dateField: "reservations.arrival_date",
    currencyTreatment: "Not applicable",
    scope: ORG_SCOPE,
    refresh: "daily",
    owner: "Front Office Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "percent",
    path: "rooms.no_show_rate",
    section: "rooms",
  },
  {
    code: "fnb_revenue",
    name: "Restaurant & Bar Revenue",
    description: "Value of completed point-of-sale orders.",
    businessMeaning: "Operational F&B trading performance.",
    formula: "Sum of grand total on closed, paid, settled or completed orders",
    numerator: "pos_orders.grand_total",
    denominator: "Not applicable",
    includedRecords: "Completed POS orders",
    excludedRecords: "Voided, cancelled and open orders",
    sources: ["pos_orders"],
    dateField: "pos_orders.created_at",
    currencyTreatment: "Property base currency, gross of tax as captured at POS",
    scope: ORG_SCOPE,
    refresh: "near_realtime",
    owner: "Restaurant Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "currency",
    path: "fnb.revenue",
    section: "restaurant",
  },
  {
    code: "average_order_value",
    name: "Average Order Value",
    description: "Average value of a completed order.",
    businessMeaning: "Upselling and menu-mix effectiveness.",
    formula: "Eligible sales revenue ÷ Completed eligible orders",
    numerator: "Completed POS order value",
    denominator: "Count of completed POS orders",
    includedRecords: "Completed POS orders",
    excludedRecords: "Voided and cancelled orders",
    sources: ["pos_orders"],
    dateField: "pos_orders.created_at",
    currencyTreatment: "Property base currency",
    scope: ORG_SCOPE,
    refresh: "near_realtime",
    owner: "Restaurant Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "currency",
    path: "fnb.average_order_value",
    section: "restaurant",
  },
  {
    code: "cost_percentage",
    name: "Food & Beverage Cost %",
    description: "Cost of stock consumed against F&B revenue.",
    businessMeaning: "Kitchen and bar cost control.",
    formula: "Cost of sales ÷ Eligible F&B revenue × 100",
    numerator: "Stock issues, consumption and wastage movements valued at cost",
    denominator: "Completed POS order value",
    includedRecords: "Immutable stock ledger movements",
    excludedRecords: "Stock transfers between locations and opening balances",
    sources: ["stock_movements", "pos_orders"],
    dateField: "stock_movements.created_at",
    currencyTreatment: "Weighted average cost from the stock ledger",
    scope: ORG_SCOPE,
    refresh: "daily",
    owner: "Kitchen Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "under_review",
    unit: "percent",
    path: "fnb.cost_percentage",
    section: "kitchen",
  },
  {
    code: "posted_revenue",
    name: "Posted Revenue",
    description: "Revenue recognised in posted double-entry journals.",
    businessMeaning: "The financial source of truth for revenue.",
    formula: "Sum of (credit − debit) on posted revenue accounts",
    numerator: "journal_entry_lines on revenue/income accounts",
    denominator: "Not applicable",
    includedRecords: "Journals with status posted",
    excludedRecords: "Drafts, pending approvals, reversed journals' original effect is netted by the reversal",
    sources: ["journal_entries", "journal_entry_lines", "chart_of_accounts"],
    dateField: "journal_entries.accounting_date",
    currencyTreatment: "Ledger currency at posted exchange rate",
    scope: ORG_SCOPE,
    refresh: "daily",
    owner: "Finance Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "currency",
    path: "finance.posted_revenue",
    section: "finance",
  },
  {
    code: "net_margin",
    name: "Net Profit Margin",
    description: "Posted profit as a share of posted revenue.",
    businessMeaning: "Overall profitability from the ledger.",
    formula: "(Posted revenue − Posted expense) ÷ Posted revenue × 100",
    numerator: "Posted revenue less posted expenses",
    denominator: "Posted revenue",
    includedRecords: "Posted journals inside open or closed accounting periods",
    excludedRecords: "Unposted operational drafts",
    sources: ["journal_entries", "journal_entry_lines"],
    dateField: "journal_entries.accounting_date",
    currencyTreatment: "Ledger currency",
    scope: ORG_SCOPE,
    refresh: "daily",
    owner: "Finance Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "percent",
    path: "finance.net_margin",
    section: "finance",
  },
  {
    code: "accounts_receivable",
    name: "Accounts Receivable",
    description: "Outstanding customer balances.",
    businessMeaning: "Cash still to be collected.",
    formula: "Sum of invoice balances greater than zero",
    numerator: "invoices.balance",
    denominator: "Not applicable",
    includedRecords: "Issued invoices with a balance",
    excludedRecords: "Cancelled invoices",
    sources: ["invoices"],
    dateField: "invoices.issue_date",
    currencyTreatment: "Invoice currency",
    scope: ORG_SCOPE,
    refresh: "hourly",
    owner: "Finance Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "currency",
    path: "finance.accounts_receivable",
    section: "finance",
  },
  {
    code: "accounts_payable",
    name: "Accounts Payable",
    description: "Outstanding supplier balances.",
    businessMeaning: "Cash owed to suppliers.",
    formula: "Sum of (invoice amount − amount paid) on unpaid supplier invoices",
    numerator: "supplier_invoices.amount − supplier_invoices.paid_amount",
    denominator: "Not applicable",
    includedRecords: "Supplier invoices not marked paid or cancelled",
    excludedRecords: "Cancelled supplier invoices",
    sources: ["supplier_invoices"],
    dateField: "supplier_invoices.invoice_date",
    currencyTreatment: "Invoice currency",
    scope: ORG_SCOPE,
    refresh: "hourly",
    owner: "Finance Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "currency",
    path: "finance.accounts_payable",
    section: "finance",
  },
  {
    code: "stock_value",
    name: "Inventory Value",
    description: "Value of stock on hand at weighted average cost.",
    businessMeaning: "Working capital held in stores.",
    formula: "Σ (quantity on hand × weighted average cost)",
    numerator: "stock_levels.quantity_on_hand × stock_items.average_cost",
    denominator: "Not applicable",
    includedRecords: "Stock levels derived from the immutable stock ledger",
    excludedRecords: "Manually typed display balances (never used)",
    sources: ["stock_levels", "stock_items"],
    dateField: "stock_levels.last_movement_at",
    currencyTreatment: "Weighted average cost",
    scope: ORG_SCOPE,
    refresh: "near_realtime",
    owner: "Storekeeper",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "currency",
    path: "inventory.stock_value",
    section: "inventory",
  },
  {
    code: "delivery_on_time_rate",
    name: "Delivery On-Time Rate",
    description: "Delivered orders that met their estimated delivery time.",
    businessMeaning: "Delivery service reliability.",
    formula: "On-time delivered orders ÷ Delivered orders × 100",
    numerator: "Delivered orders where delivered_at ≤ estimated_delivery_at",
    denominator: "All delivered orders",
    includedRecords: "Orders with a recorded estimate and delivery time",
    excludedRecords: "Cancelled, failed and rejected orders",
    sources: ["delivery_orders"],
    dateField: "delivery_orders.created_at",
    currencyTreatment: "Not applicable",
    scope: ORG_SCOPE,
    refresh: "near_realtime",
    owner: "Delivery Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "percent",
    path: "delivery.on_time_rate",
    section: "delivery",
  },
  {
    code: "event_revenue",
    name: "Event Revenue",
    description: "Value of confirmed and completed events in the period.",
    businessMeaning: "Banqueting and conferencing contribution.",
    formula: "Sum of confirmed event booking totals",
    numerator: "event_bookings.total_amount",
    denominator: "Not applicable",
    includedRecords: "Confirmed and completed bookings",
    excludedRecords: "Enquiries, tentative holds and cancelled events",
    sources: ["event_bookings"],
    dateField: "event_bookings.event_date",
    currencyTreatment: "Booking currency",
    scope: ORG_SCOPE,
    refresh: "daily",
    owner: "Events Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "currency",
    path: "events.revenue",
    section: "events",
  },
  {
    code: "average_rating",
    name: "Customer Satisfaction",
    description: "Average rating on recorded customer feedback.",
    businessMeaning: "Guest experience signal.",
    formula: "Average of recorded feedback ratings",
    numerator: "customer_feedback.rating",
    denominator: "Count of rated feedback records",
    includedRecords: "Feedback captured in the period",
    excludedRecords: "Feedback with no rating supplied",
    sources: ["customer_feedback"],
    dateField: "customer_feedback.created_at",
    currencyTreatment: "Not applicable",
    scope: ORG_SCOPE,
    refresh: "near_realtime",
    owner: "Marketing Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "number",
    path: "customers.average_rating",
    section: "customers",
  },
  {
    code: "active_employees",
    name: "Active Headcount",
    description: "Employees in an active employment status.",
    businessMeaning: "Workforce capacity available to operations.",
    formula: "Count of employees in active, probation or confirmed status",
    numerator: "employees",
    denominator: "Not applicable",
    includedRecords: "Employee records only — never login accounts or customers",
    excludedRecords: "Exited employees, candidates and customer accounts",
    sources: ["employees"],
    dateField: "employees.employment_date",
    currencyTreatment: "Not applicable",
    scope: ORG_SCOPE,
    refresh: "daily",
    owner: "HR Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "number",
    path: "people.active_employees",
    section: "workforce",
  },
  {
    code: "labour_cost_percentage",
    name: "Labour Cost %",
    description: "Approved labour cost against eligible revenue.",
    businessMeaning: "Payroll efficiency relative to trading.",
    formula: "Approved labour cost ÷ Eligible revenue × 100",
    numerator: "Approved payroll cost (requires authorised payroll data)",
    denominator: "Eligible revenue",
    includedRecords: "Approved payroll periods only",
    excludedRecords: "Draft payroll, individual salaries and personal compensation detail",
    sources: ["payroll_periods", "payroll_input_records"],
    dateField: "payroll_periods.period_end",
    currencyTreatment: "Payroll currency",
    scope: "Requires HR analytics permission in addition to analytics view",
    refresh: "scheduled",
    owner: "HR Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "draft",
    unit: "percent",
    path: "finance.labour_cost",
    section: "workforce",
  },
  {
    code: "housekeeping_avg_minutes",
    name: "Average Cleaning Time",
    description: "Average minutes between housekeeping job start and completion.",
    businessMeaning: "Room turnaround productivity.",
    formula: "Average (completed_at − started_at) in minutes",
    numerator: "Completed housekeeping jobs with both timestamps",
    denominator: "Count of those jobs",
    includedRecords: "Completed housekeeping jobs",
    excludedRecords: "Jobs missing a start or completion timestamp",
    sources: ["housekeeping_jobs"],
    dateField: "housekeeping_jobs.created_at",
    currencyTreatment: "Not applicable",
    scope: ORG_SCOPE,
    refresh: "near_realtime",
    owner: "Housekeeping Supervisor",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "minutes",
    path: "operations.housekeeping_avg_minutes",
    section: "operations",
  },
  {
    code: "maintenance_avg_hours",
    name: "Average Resolution Time",
    description: "Average hours from fault report to completion.",
    businessMeaning: "Maintenance responsiveness and room downtime risk.",
    formula: "Average (completed_at − reported_at) in hours",
    numerator: "Completed work orders",
    denominator: "Count of completed work orders",
    includedRecords: "Work orders with a completion timestamp",
    excludedRecords: "Open and cancelled work orders",
    sources: ["maintenance_work_orders"],
    dateField: "maintenance_work_orders.reported_at",
    currencyTreatment: "Not applicable",
    scope: ORG_SCOPE,
    refresh: "near_realtime",
    owner: "Maintenance Manager",
    version: 1,
    effectiveDate: "2026-01-01",
    status: "active",
    unit: "hours",
    path: "operations.maintenance_avg_hours",
    section: "operations",
  },
];

export const metricByCode = (code: string) => METRIC_CATALOGUE.find((m) => m.code === code);

export const metricsForSection = (section: AnalyticsSectionKey) =>
  METRIC_CATALOGUE.filter((m) => m.section === section);

/** Reads a dot path out of a `bi_kpis()` payload. */
export function metricValue(kpis: Row | undefined, path: string): number | null {
  if (!kpis) return null;
  const value = path.split(".").reduce<any>((acc, key) => (acc == null ? acc : acc[key]), kpis);
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* ================================================================== *
 * Formatting
 * ================================================================== */

export function formatMetric(unit: MetricUnit, value: number | null, symbol = ""): string {
  if (value === null) return "—";
  switch (unit) {
    case "currency":
      return `${symbol}${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    case "percent":
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    case "hours":
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;
    case "minutes":
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} min`;
    case "nights":
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} nights`;
    default:
      return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
}

export function deltaLabel(current: number | null, previous: number | null): string | null {
  if (current === null || previous === null || previous === 0) return null;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}% vs previous period`;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function shiftRange(from: string, to: string) {
  const f = new Date(from);
  const t = new Date(to);
  const days = Math.max(Math.round((t.getTime() - f.getTime()) / 86_400_000) + 1, 1);
  return {
    from: isoDate(new Date(f.getTime() - days * 86_400_000)),
    to: isoDate(new Date(t.getTime() - days * 86_400_000)),
    days,
  };
}

/* ================================================================== *
 * Deterministic forecasting
 *
 * Method: weekday-seasonal moving average over the supplied history.
 * It is transparent, reproducible and never presented as a guarantee.
 * ================================================================== */

export const FORECAST_MODEL = { code: "wsma", version: "v1", minHistoryDays: 28 } as const;

export type ForecastPoint = {
  date: string;
  predicted: number;
  lower: number;
  upper: number;
};

export type ForecastResult = {
  points: ForecastPoint[];
  sufficiency: "sufficient" | "limited" | "insufficient";
  method: string;
  modelVersion: string;
  historyDays: number;
  limitations: string;
};

export function forecastSeries(
  series: { date: string; value: number }[],
  horizonDays: number,
): ForecastResult {
  const history = series.filter((p) => Number.isFinite(p.value));
  const n = history.length;
  const sufficiency = n >= FORECAST_MODEL.minHistoryDays ? "sufficient" : n >= 14 ? "limited" : "insufficient";

  if (sufficiency === "insufficient") {
    return {
      points: [],
      sufficiency,
      method: "Weekday-seasonal moving average",
      modelVersion: FORECAST_MODEL.version,
      historyDays: n,
      limitations:
        "Insufficient Data for Reliable Forecast — at least 14 days of history is required before any projection is produced.",
    };
  }

  const overallMean = history.reduce((s, p) => s + p.value, 0) / n;
  const byWeekday = new Map<number, number[]>();
  for (const p of history) {
    const wd = new Date(p.date).getUTCDay();
    byWeekday.set(wd, [...(byWeekday.get(wd) ?? []), p.value]);
  }
  const factor = (wd: number) => {
    const vals = byWeekday.get(wd);
    if (!vals || !vals.length || overallMean === 0) return 1;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    return mean / overallMean;
  };

  const residuals = history.map((p) => p.value - overallMean * factor(new Date(p.date).getUTCDay()));
  const variance = residuals.reduce((s, r) => s + r * r, 0) / Math.max(residuals.length - 1, 1);
  const sd = Math.sqrt(variance);
  const band = sufficiency === "limited" ? 1.96 * sd * 1.4 : 1.96 * sd;

  const last = new Date(history[history.length - 1]!.date);
  const points: ForecastPoint[] = [];
  for (let i = 1; i <= horizonDays; i += 1) {
    const d = new Date(last.getTime() + i * 86_400_000);
    const predicted = Math.max(overallMean * factor(d.getUTCDay()), 0);
    points.push({
      date: isoDate(d),
      predicted: Number(predicted.toFixed(2)),
      lower: Number(Math.max(predicted - band, 0).toFixed(2)),
      upper: Number((predicted + band).toFixed(2)),
    });
  }

  return {
    points,
    sufficiency,
    method: "Weekday-seasonal moving average over the selected history window",
    modelVersion: FORECAST_MODEL.version,
    historyDays: n,
    limitations:
      sufficiency === "limited"
        ? "Limited history — confidence range widened. Treat as indicative only."
        : "Statistical projection from recorded history only. It does not know about unrecorded closures, unconfirmed events or price changes.",
  };
}

export function forecastAccuracy(pairs: { predicted: number; actual: number }[]) {
  if (!pairs.length) return null;
  const errors = pairs.map((p) => Math.abs(p.predicted - p.actual));
  const mae = errors.reduce((s, e) => s + e, 0) / pairs.length;
  const mapeVals = pairs.filter((p) => p.actual !== 0).map((p) => Math.abs((p.predicted - p.actual) / p.actual) * 100);
  const mape = mapeVals.length ? mapeVals.reduce((s, e) => s + e, 0) / mapeVals.length : null;
  return { mae, mape, samples: pairs.length };
}

/* ================================================================== *
 * Deterministic advisory recommendations
 * ================================================================== */

export type Advisory = {
  reference: string;
  title: string;
  category: string;
  observation: string;
  recommendedAction: string;
  expectedImpact: string;
  confidence: "low" | "medium" | "high";
  limitations: string;
  supporting: { label: string; value: string }[];
  generatedBy: "rules";
};

export function buildAdvisories(kpis: Row | undefined, risk: Row | undefined, symbol: string): Advisory[] {
  const out: Advisory[] = [];
  if (!kpis) return out;

  const occ = metricValue(kpis, "rooms.occupancy_rate");
  const adr = metricValue(kpis, "rooms.adr");
  const lowStock = metricValue(kpis, "inventory.low_stock_items");
  const oos = metricValue(kpis, "inventory.out_of_stock_items");
  const ar = metricValue(kpis, "finance.accounts_receivable");
  const rating = metricValue(kpis, "customers.average_rating");
  const mtOpen = metricValue(kpis, "operations.maintenance_open");
  const delOnTime = metricValue(kpis, "delivery.on_time_rate");
  const costPct = metricValue(kpis, "fnb.cost_percentage");

  const push = (a: Omit<Advisory, "reference" | "generatedBy">) =>
    out.push({ ...a, reference: `REC-${a.category.slice(0, 3).toUpperCase()}-${out.length + 1}`, generatedBy: "rules" });

  if (occ !== null && occ < 55) {
    push({
      title: "Low occupancy in the selected period",
      category: "Campaign opportunity",
      observation: `Occupancy is ${occ.toFixed(1)}% against sellable inventory for the selected period.`,
      recommendedAction:
        "Review a low-demand campaign or package with Marketing, and confirm rate positioning with the General Manager before any change.",
      expectedImpact: "Potentially higher on-books occupancy on soft dates. Not quantified.",
      confidence: occ < 40 ? "high" : "medium",
      limitations: "Based only on recorded reservations. Unrecorded group holds or closures are not visible.",
      supporting: [
        { label: "Occupancy Rate", value: `${occ.toFixed(1)}%` },
        { label: "ADR", value: adr === null ? "—" : `${symbol}${adr.toFixed(0)}` },
      ],
    });
  }

  if ((oos ?? 0) > 0 || (lowStock ?? 0) > 0) {
    push({
      title: "Stock shortage warning",
      category: "Stock",
      observation: `${oos ?? 0} item(s) are out of stock and ${lowStock ?? 0} item(s) are at or below minimum level.`,
      recommendedAction:
        "Review reorder recommendations in Inventory Analytics and raise a draft purchase request through the existing procurement workflow.",
      expectedImpact: "Reduced risk of menu items or amenities becoming unavailable.",
      confidence: "high",
      limitations: "Reads the immutable stock ledger only; open purchase orders may already cover some items.",
      supporting: [
        { label: "Out of stock", value: String(oos ?? 0) },
        { label: "At/below minimum", value: String(lowStock ?? 0) },
      ],
    });
  }

  if (ar !== null && ar > 0) {
    push({
      title: "Debt collection priority",
      category: "Finance",
      observation: `${symbol}${ar.toLocaleString()} is outstanding on issued invoices.`,
      recommendedAction: "Prioritise collection follow-up on the oldest balances in Finance → Receivables.",
      expectedImpact: "Improved cash position. Amount recovered is not predicted.",
      confidence: "medium",
      limitations: "Uses invoice balances only; unapplied payments in transit are not visible here.",
      supporting: [{ label: "Accounts Receivable", value: `${symbol}${ar.toLocaleString()}` }],
    });
  }

  if (rating !== null && rating < 4) {
    push({
      title: "Guest satisfaction decline",
      category: "Guest experience",
      observation: `Average recorded feedback rating is ${rating.toFixed(2)} for the selected period.`,
      recommendedAction: "Review open feedback themes and service recovery cases with the department managers concerned.",
      expectedImpact: "Better recovery outcomes and repeat-stay likelihood. Not quantified.",
      confidence: "medium",
      limitations: "Only covers feedback captured in the system; it is not a market review score.",
      supporting: [{ label: "Average rating", value: rating.toFixed(2) }],
    });
  }

  if (mtOpen !== null && mtOpen > 0) {
    push({
      title: "Preventive maintenance review",
      category: "Maintenance",
      observation: `${mtOpen} work order(s) are still open.`,
      recommendedAction: "Review overdue work orders and room blocks with the Maintenance Manager.",
      expectedImpact: "Less room downtime and fewer repeat faults.",
      confidence: "medium",
      limitations: "Open count only; it does not judge technician workload or parts availability.",
      supporting: [{ label: "Open work orders", value: String(mtOpen) }],
    });
  }

  if (delOnTime !== null && delOnTime < 85) {
    push({
      title: "Delivery rider coverage",
      category: "Delivery",
      observation: `On-time delivery rate is ${delOnTime.toFixed(1)}%.`,
      recommendedAction: "Review rider coverage against peak ordering periods with the Delivery Manager.",
      expectedImpact: "Improved on-time service level.",
      confidence: "medium",
      limitations: "Only orders carrying an estimated delivery time are measured.",
      supporting: [{ label: "On-time rate", value: `${delOnTime.toFixed(1)}%` }],
    });
  }

  if (costPct !== null && costPct > 40) {
    push({
      title: "Menu and cost review",
      category: "Kitchen",
      observation: `Cost of stock consumed is ${costPct.toFixed(1)}% of recorded F&B revenue.`,
      recommendedAction:
        "Review recipe variance, portioning and wastage with the Kitchen Manager before changing any menu price.",
      expectedImpact: "Lower food and beverage cost percentage.",
      confidence: "low",
      limitations:
        "Stock issues are not perfectly matched to sales periods; treat as a directional signal, not a costed margin.",
      supporting: [{ label: "Cost %", value: `${costPct.toFixed(1)}%` }],
    });
  }

  const signals = (risk?.["signals"] as Row[] | undefined) ?? [];
  const critical = signals.filter((s) => s["severity"] === "critical" && Number(s["observed"]) > 0);
  if (critical.length) {
    push({
      title: "Critical risk signals require review",
      category: "Risk",
      observation: `${critical.length} critical signal(s) detected: ${critical.map((c) => c["category"]).join(", ")}.`,
      recommendedAction: "Open Risk & Anomalies and assign a reviewer. An anomaly is not proof of wrongdoing.",
      expectedImpact: "Earlier detection of control failures.",
      confidence: "medium",
      limitations: "Rule-based counts only. Every alert requires human review before any conclusion.",
      supporting: critical.map((c) => ({ label: String(c["category"]), value: String(c["observed"]) })),
    });
  }

  return out;
}

/* ================================================================== *
 * Allowlisted semantic layer for the AI assistant
 * ================================================================== */

export type SemanticIntent = {
  id: string;
  question: string;
  description: string;
  metricPaths: string[];
  sources: string[];
  keywords: string[];
  permission: { module: string; action: string };
  classification: "fact" | "calculation" | "forecast";
};

/**
 * The assistant may only answer from these intents. Anything else is refused —
 * there is no free-form SQL path, and no table is exposed to the model.
 */
export const SEMANTIC_INTENTS: SemanticIntent[] = [
  {
    id: "rooms_available",
    question: "How many rooms are available tonight?",
    description: "Sellable rooms less occupied rooms for the current date.",
    metricPaths: ["rooms.sellable_rooms", "rooms.occupied_room_nights", "rooms.occupancy_rate"],
    sources: ["rooms", "reservations"],
    keywords: ["room", "available", "vacant", "tonight", "occupancy"],
    permission: { module: "front-office", action: "view" },
    classification: "calculation",
  },
  {
    id: "restaurant_revenue",
    question: "Show today's restaurant revenue.",
    description: "Completed point-of-sale order value for the selected period.",
    metricPaths: ["fnb.revenue", "fnb.orders", "fnb.average_order_value"],
    sources: ["pos_orders"],
    keywords: ["restaurant", "bar", "sales", "revenue", "orders", "covers"],
    permission: { module: "restaurant", action: "view" },
    classification: "fact",
  },
  {
    id: "overdue_invoices",
    question: "Which authorized invoices are overdue?",
    description: "Outstanding receivables and payables from Finance.",
    metricPaths: ["finance.accounts_receivable", "finance.accounts_payable"],
    sources: ["invoices", "supplier_invoices"],
    keywords: ["invoice", "overdue", "receivable", "payable", "debt", "owed"],
    permission: { module: "finance", action: "view" },
    classification: "fact",
  },
  {
    id: "stock_position",
    question: "What stock items may run out this week?",
    description: "Stock value plus items at or below minimum level.",
    metricPaths: ["inventory.stock_value", "inventory.low_stock_items", "inventory.out_of_stock_items"],
    sources: ["stock_levels", "stock_items"],
    keywords: ["stock", "inventory", "run out", "oil", "shortage", "store"],
    permission: { module: "stores", action: "view" },
    classification: "fact",
  },
  {
    id: "occupancy_report",
    question: "Generate this month's occupancy report.",
    description: "Occupancy, ADR and RevPAR for the selected period.",
    metricPaths: ["rooms.occupancy_rate", "rooms.adr", "rooms.revpar"],
    sources: ["reservations", "rooms", "folio_lines"],
    keywords: ["occupancy", "adr", "revpar", "report", "month"],
    permission: { module: "front-office", action: "view" },
    classification: "calculation",
  },
  {
    id: "housekeeping_status",
    question: "Which rooms are awaiting inspection?",
    description: "Housekeeping completion and turnaround for the period.",
    metricPaths: ["operations.housekeeping_completed", "operations.housekeeping_avg_minutes"],
    sources: ["housekeeping_jobs"],
    keywords: ["housekeeping", "clean", "inspection", "room ready"],
    permission: { module: "housekeeping", action: "view" },
    classification: "fact",
  },
  {
    id: "delivery_performance",
    question: "Summarize today's delivery delays.",
    description: "Delivery volume, failures and on-time rate.",
    metricPaths: ["delivery.orders", "delivery.failed", "delivery.on_time_rate"],
    sources: ["delivery_orders"],
    keywords: ["delivery", "rider", "late", "delay", "on time"],
    permission: { module: "delivery", action: "view" },
    classification: "fact",
  },
  {
    id: "events_upcoming",
    question: "Which conference arrives tomorrow?",
    description: "Confirmed event revenue and pipeline for the period.",
    metricPaths: ["events.confirmed", "events.revenue", "events.pipeline_value"],
    sources: ["event_bookings"],
    keywords: ["event", "conference", "banquet", "wedding", "booking"],
    permission: { module: "events", action: "view" },
    classification: "fact",
  },
  {
    id: "financial_position",
    question: "How is the business performing financially?",
    description: "Posted revenue, expense and margin from the ledger.",
    metricPaths: ["finance.posted_revenue", "finance.posted_expense", "finance.net_margin"],
    sources: ["journal_entries", "journal_entry_lines"],
    keywords: ["profit", "margin", "financial", "posted", "ledger", "expense"],
    permission: { module: "finance", action: "view" },
    classification: "calculation",
  },
];

/** Very deliberate keyword match — no model is allowed to pick the query. */
export function resolveIntent(question: string): SemanticIntent | null {
  const q = question.toLowerCase();
  let best: { intent: SemanticIntent; score: number } | null = null;
  for (const intent of SEMANTIC_INTENTS) {
    const score = intent.keywords.reduce((s, k) => (q.includes(k) ? s + 1 : s), 0);
    if (score > 0 && (!best || score > best.score)) best = { intent, score };
  }
  return best?.intent ?? null;
}

export const REFUSAL_MESSAGE =
  "I can only answer from the approved metric catalogue, and only for data you are permitted to see. " +
  "I cannot run free-form queries, read personal HR or customer records, or change anything. " +
  "Try asking about occupancy, room availability, restaurant revenue, stock levels, receivables, events, housekeeping or delivery performance.";

/* ================================================================== *
 * Status vocabularies shared by the UI
 * ================================================================== */

export const RECOMMENDATION_STATUSES = [
  "new",
  "reviewed",
  "accepted",
  "dismissed",
  "converted",
  "expired",
  "resolved",
] as const;

export const RISK_STATUSES = [
  "new",
  "under_review",
  "investigating",
  "confirmed",
  "false_positive",
  "resolved",
  "escalated",
  "closed",
] as const;

export const statusLabels: Record<string, string> = {
  new: "New",
  reviewed: "Reviewed",
  accepted: "Accepted for Action",
  dismissed: "Dismissed",
  converted: "Converted to Task",
  expired: "Expired",
  resolved: "Resolved",
  under_review: "Under Review",
  investigating: "Investigating",
  confirmed: "Confirmed Issue",
  false_positive: "False Positive",
  escalated: "Escalated",
  closed: "Closed",
  draft: "Draft",
  approved: "Approved",
  active: "Active",
  deprecated: "Deprecated",
  testing: "Testing",
  paused: "Paused",
  retired: "Retired",
};

export function severityTone(severity: string): "default" | "success" | "warning" | "info" | "destructive" {
  if (severity === "critical") return "destructive";
  if (severity === "warning") return "warning";
  if (severity === "info") return "info";
  return "default";
}
