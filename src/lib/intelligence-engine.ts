/**
 * NEØ Intelligence — deterministic detection, comparison and decision engine.
 *
 * Every function here is pure and reads only the already-authorised
 * `neo_intelligence` payload, which resolves organisation, property, period and
 * capability inside the database. Nothing is estimated: a figure that cannot be
 * derived from operational records is reported as missing.
 */
import type { IntelligencePayload } from "@/lib/intelligence-data";
import type {
  ChangeItem,
  Confidence,
  Decision,
  Discovery,
  Evidence,
  Investigation,
  NeoModule,
  Scope,
  Severity,
  Statement,
  Visualization,
} from "@/lib/intelligence-types";

export const num = (payload: IntelligencePayload | undefined, key: string): number | null => {
  const raw = payload?.briefing?.[key];
  if (raw === null || raw === undefined || typeof raw === "boolean") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export function scopeOf(payload: IntelligencePayload | undefined, propertyLabel: string): Scope {
  return {
    propertyLabel,
    from: payload?.period?.from ?? "—",
    to: payload?.period?.to ?? "—",
    freshness: payload?.generated_at,
  };
}

/* ------------------------------------------------------------------ *
 * Discoveries — rule-based detectors over scoped records.
 * ------------------------------------------------------------------ */

type Detector = {
  id: string;
  module: NeoModule;
  modules?: NeoModule[];
  title: string;
  /** Reads the magnitude; a null or zero magnitude means "nothing detected". */
  magnitude: (p: IntelligencePayload) => number | null;
  conclusion: (n: number, p: IntelligencePayload) => string;
  severity: (n: number) => Severity;
  actionable: boolean;
  drillTo: string;
  source: string;
  evidenceLabel: string;
  investigate?: string;
  /** Money impact only where it is directly recorded, never inferred. */
  impact?: (p: IntelligencePayload) => number | null;
};

const DETECTORS: Detector[] = [
  {
    id: "finance-unposted",
    module: "finance",
    title: "Finance posting backlog",
    magnitude: (p) => num(p, "unmatched_eligible"),
    conclusion: (n) => `${n} eligible operational record(s) have no matching Finance posting.`,
    severity: (n) => (n >= 10 ? "critical" : "warning"),
    actionable: true,
    drillTo: "/finance/posting",
    source: "neo_unmatched_facts",
    evidenceLabel: "Eligible records without a posting",
    investigate: "finance-unposted",
  },
  {
    id: "finance-failed",
    module: "finance",
    title: "Failed Finance postings",
    magnitude: (p) => num(p, "failed_postings"),
    conclusion: (n) => `${n} posting attempt(s) failed and are awaiting an authorised recovery.`,
    severity: () => "critical",
    actionable: true,
    drillTo: "/finance/posting",
    source: "finance_posting_receipts (status failed)",
    evidenceLabel: "Failed posting receipts",
    investigate: "finance-unposted",
  },
  {
    id: "rooms-unavailable",
    module: "pms",
    modules: ["pms", "housekeeping"],
    title: "Rooms not sellable",
    magnitude: (p) => num(p, "unavailable_rooms"),
    conclusion: (n) => `${n} room(s) cannot be sold in this property right now.`,
    severity: (n) => (n >= 20 ? "critical" : n >= 5 ? "warning" : "info"),
    actionable: true,
    drillTo: "/pms/rooms",
    source: "rooms + ops_room_state",
    evidenceLabel: "Rooms blocked, out of order or not released",
    investigate: "rooms-unavailable",
  },
  {
    id: "tasks-overdue",
    module: "workforce",
    title: "Overdue operational commitments",
    magnitude: (p) => num(p, "overdue_tasks"),
    conclusion: (n) => `${n} task(s) are past their due time and not completed.`,
    severity: (n) => (n >= 15 ? "critical" : "warning"),
    actionable: true,
    drillTo: "/tasks",
    source: "tasks past due_at",
    evidenceLabel: "Tasks past due",
  },
  {
    id: "approvals-waiting",
    module: "workforce",
    modules: ["workforce", "finance"],
    title: "Approvals blocking downstream work",
    magnitude: (p) => num(p, "pending_approvals"),
    conclusion: (n) => `${n} approval request(s) are pending or mid-execution.`,
    severity: (n) => (n >= 10 ? "warning" : "info"),
    actionable: true,
    drillTo: "/approvals",
    source: "approval_requests (pending / executing)",
    evidenceLabel: "Approval requests waiting",
  },
  {
    id: "workflows-failed",
    module: "workforce",
    title: "Unresolved automation failures",
    magnitude: (p) => num(p, "failed_workflows"),
    conclusion: (n) => `${n} workflow run(s) failed and remain unresolved.`,
    severity: () => "warning",
    actionable: true,
    drillTo: "/automation/failures",
    source: "workflow_failures",
    evidenceLabel: "Unresolved workflow failures",
  },
  {
    id: "pos-open-value",
    module: "pos",
    title: "Open point-of-sale value",
    magnitude: (p) => num(p, "pos_open_value"),
    conclusion: (n, p) =>
      `${formatMoney(n, p.currency ?? "")} of point-of-sale value is still open and unsettled.`,
    severity: () => "info",
    actionable: true,
    drillTo: "/pos/orders",
    source: "pos_orders still open in service",
    evidenceLabel: "Open point-of-sale orders",
    impact: (p) => num(p, "pos_open_value"),
  },
  {
    id: "menu-uncosted",
    module: "kitchen",
    modules: ["kitchen", "inventory"],
    title: "Menu items that cannot be analysed",
    magnitude: (p) => {
      const total = p.menu?.items_total ?? 0;
      const costed = p.menu?.items_costed ?? 0;
      return total - costed;
    },
    conclusion: (n) =>
      `${n} menu item(s) have no costed recipe, so their margin cannot be analysed. NEØ does not estimate a margin.`,
    severity: (n) => (n >= 20 ? "warning" : "info"),
    actionable: true,
    drillTo: "/kitchen/recipes",
    source: "menu_items without a costed recipe",
    evidenceLabel: "Menu items missing recipe cost",
    investigate: "menu-uncosted",
  },
  {
    id: "guest-detractors",
    module: "crm",
    title: "Low guest ratings received",
    magnitude: (p) => p.sentiment?.detractors ?? null,
    conclusion: (n) => `${n} guest rating(s) of 2 or below were submitted in this period.`,
    severity: (n) => (n >= 5 ? "warning" : "info"),
    actionable: true,
    drillTo: "/crm/feedback",
    source: "submitted guest feedback ratings",
    evidenceLabel: "Ratings of 2 or below",
  },
  {
    id: "receivables-open",
    module: "finance",
    title: "Outstanding receivables",
    magnitude: (p) => num(p, "receivables"),
    conclusion: (n, p) => `${formatMoney(n, p.currency ?? "")} remains receivable in this scope.`,
    severity: () => "info",
    actionable: true,
    drillTo: "/finance/receivables",
    source: "receivables ledger",
    evidenceLabel: "Open receivable balance",
    impact: (p) => num(p, "receivables"),
  },
  {
    id: "booking-pace",
    module: "pms",
    title: "Weak forward booking pace",
    magnitude: (p) => {
      const fwd = p.demand?.forward ?? [];
      if (fwd.length === 0) return null;
      const books = fwd.reduce((s, d) => s + Number(d.on_the_books ?? 0), 0);
      const sellable = fwd.reduce((s, d) => s + Number(d.sellable ?? 0), 0);
      if (sellable <= 0) return null;
      const pace = (books * 100) / sellable;
      return pace < 40 ? Math.round(100 - pace) : null;
    },
    conclusion: (n) =>
      `Forward reservations cover only ${100 - n}% of sellable room nights over the next 14 days. This is booking pace from records, not a statistical forecast.`,
    severity: (n) => (n >= 80 ? "warning" : "info"),
    actionable: true,
    drillTo: "/pms/availability",
    source: "reservations on the books vs sellable rooms",
    evidenceLabel: "Forward reservation nights on the books",
    investigate: "booking-pace",
  },
];

function formatMoney(value: number, currency: string): string {
  return `${currency ? `${currency} ` : ""}${new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(value)}`;
}

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 60, warning: 38, info: 18 };

/** Magnitude contribution, damped so one huge number cannot dominate ranking. */
function materiality(magnitude: number): number {
  if (magnitude <= 0) return 0;
  return Math.min(30, Math.round(Math.log10(magnitude + 1) * 12));
}

export function buildDiscoveries(payload: IntelligencePayload | undefined): Discovery[] {
  if (!payload || payload.authorised === false) return [];
  const currency = payload.currency ?? "";
  const moneyVisible = payload.money_visible === true;
  const out: Discovery[] = [];

  for (const d of DETECTORS) {
    const magnitude = d.magnitude(payload);
    if (magnitude === null || magnitude <= 0) continue;
    const impactValue = d.impact && moneyVisible ? d.impact(payload) : null;
    const severity = d.severity(magnitude);
    const evidence: Evidence[] = [
      {
        label: d.evidenceLabel,
        recordCount: Number.isInteger(magnitude) ? magnitude : null,
        source: d.source,
        module: d.module,
        drillTo: d.drillTo,
      },
    ];
    out.push({
      id: d.id,
      title: d.title,
      conclusion: d.conclusion(magnitude, payload),
      severity,
      score:
        SEVERITY_WEIGHT[severity] +
        materiality(magnitude) +
        (d.actionable ? 10 : 0) +
        (impactValue ? 5 : 0),
      magnitude,
      impact: impactValue !== null ? { value: impactValue, currency } : null,
      impactNote:
        impactValue !== null
          ? "Value taken directly from recorded balances."
          : "Impact not quantified — no recorded monetary value can be attributed safely.",
      modules: d.modules ?? [d.module],
      evidence,
      actionable: d.actionable,
      drillTo: d.drillTo,
      confidence: impactValue !== null ? "high" : Number.isInteger(magnitude) ? "high" : "moderate",
      confidenceNote:
        impactValue !== null
          ? "Counted directly from operational records, with a recorded monetary value attached."
          : "Counted directly from operational records; no monetary value is attached to it.",
      ...(d.investigate ? { investigate: d.investigate } : {}),
    });
  }

  // Anomalies produced by the database are first-class discoveries too.
  for (const a of payload.anomalies ?? []) {
    if (a.severity === "ok") continue;
    if (out.some((d) => d.id === a.key)) continue;
    const severity: Severity = a.severity === "critical" ? "critical" : a.severity === "warning" ? "warning" : "info";
    out.push({
      id: `anomaly-${a.key}`,
      title: a.title,
      conclusion: a.detail,
      severity,
      score: SEVERITY_WEIGHT[severity] + 8,
      magnitude: 1,
      impact: null,
      impactNote: "Impact not quantified.",
      modules: [moduleForRoute(a.drill_to)],
      evidence: [{ label: "Anomaly evidence", source: a.evidence, module: moduleForRoute(a.drill_to), drillTo: a.drill_to }],
      actionable: true,
      drillTo: a.drill_to,
      confidence: "high",
      confidenceNote: "Raised by a database rule over the same scoped records.",
    });
  }

  out.push(...buildOutliers(payload));

  return out.sort((a, b) => b.score - a.score || b.magnitude - a.magnitude);
}

/**
 * Statistical outliers over the recorded demand history.
 *
 * A day is only reported when there are enough observations for the test to
 * mean anything (>= 7 days with a recorded occupancy) and the day sits at least
 * two standard deviations from the period's own mean. Confidence follows the
 * sample: a fortnight or more of records is "high", a short week "moderate".
 * Nothing is smoothed, extrapolated or filled in.
 */
export function buildOutliers(payload: IntelligencePayload | undefined): Discovery[] {
  const history = (payload?.demand?.history ?? []).filter(
    (p): p is { day: string; occupancy: number } =>
      p.occupancy !== null && p.occupancy !== undefined && Number.isFinite(Number(p.occupancy)),
  );
  if (history.length < 7) return [];

  const values = history.map((p) => Number(p.occupancy));
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  if (sd < 1) return []; // A flat period has no meaningful outlier.

  const flagged = history
    .map((p) => ({ day: String(p.day).slice(0, 10), value: Number(p.occupancy), z: (Number(p.occupancy) - mean) / sd }))
    .filter((p) => Math.abs(p.z) >= 2)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 3);

  const confidence: Confidence = history.length >= 14 ? "high" : "moderate";

  return flagged.map((p) => {
    const direction = p.z > 0 ? "above" : "below";
    const severity: Severity = p.z < 0 ? "warning" : "info";
    return {
      id: `outlier-occupancy-${p.day}`,
      title: `Occupancy on ${p.day} is an outlier`,
      conclusion: `${p.day} recorded ${p.value.toFixed(1)}% occupancy — ${Math.abs(p.z).toFixed(1)} standard deviations ${direction} the ${mean.toFixed(1)}% average of the ${history.length} recorded days in this period.`,
      severity,
      score: SEVERITY_WEIGHT[severity] + Math.min(20, Math.round(Math.abs(p.z) * 6)),
      magnitude: Math.round(Math.abs(p.value - mean)),
      impact: null,
      impactNote: "Impact not quantified — occupancy movement alone does not carry a recorded monetary value.",
      modules: ["pms"],
      evidence: [
        {
          label: `Room state for ${p.day}`,
          recordCount: history.length,
          source: "recorded daily occupancy for this property and period",
          module: "pms",
          drillTo: "/pms/availability",
        },
      ],
      actionable: true,
      drillTo: "/pms/availability",
      investigate: "occupancy",
      confidence,
      confidenceNote: `Tested against ${history.length} days of recorded occupancy in this scope. Fewer than 14 days is reported as moderate confidence.`,
      outlier: true,
    } satisfies Discovery;
  });
}


export function moduleForRoute(route: string): NeoModule {
  if (route.startsWith("/finance")) return "finance";
  if (route.startsWith("/pos")) return "pos";
  if (route.startsWith("/kitchen")) return "kitchen";
  if (route.startsWith("/housekeeping")) return "housekeeping";
  if (route.startsWith("/inventory") || route.startsWith("/stores")) return "inventory";
  if (route.startsWith("/procurement")) return "procurement";
  if (route.startsWith("/events")) return "events";
  if (route.startsWith("/crm")) return "crm";
  if (route.startsWith("/delivery")) return "delivery";
  if (route.startsWith("/pms")) return "pms";
  return "workforce";
}

/* ------------------------------------------------------------------ *
 * "What changed?" — grounded comparison against the prior window.
 * ------------------------------------------------------------------ */

type ChangeSpec = {
  id: string;
  label: string;
  key: string;
  unit: ChangeItem["unit"];
  module: NeoModule;
  source: string;
  drillTo: string;
  /** Rising is good, bad or neutral for the business. */
  rising: ChangeItem["favourable"];
  /** Absolute movement below this is noise. */
  floor: number;
};

const CHANGE_SPECS: ChangeSpec[] = [
  { id: "occupancy", label: "Occupancy rate", key: "occupancy_rate", unit: "percent", module: "pms", source: "ops_room_state", drillTo: "/pms/availability", rising: "good", floor: 3 },
  { id: "revenue", label: "Recognised revenue", key: "net_recognised_revenue", unit: "money", module: "finance", source: "posted journals net of reversals", drillTo: "/finance/journals", rising: "good", floor: 1 },
  { id: "collected", label: "Collected", key: "collected", unit: "money", module: "finance", source: "collections", drillTo: "/finance/queue", rising: "good", floor: 1 },
  { id: "receivables", label: "Receivables", key: "receivables", unit: "money", module: "finance", source: "receivables ledger", drillTo: "/finance/receivables", rising: "bad", floor: 1 },
  { id: "pos-sales", label: "Finalised POS sales", key: "pos_finalised_sales", unit: "money", module: "pos", source: "settled pos_orders", drillTo: "/pos/orders", rising: "good", floor: 1 },
  { id: "pos-open", label: "Open POS value", key: "pos_open_value", unit: "money", module: "pos", source: "open pos_orders", drillTo: "/pos/orders", rising: "bad", floor: 1 },
  { id: "arrivals", label: "Arrivals today", key: "arrivals_today", unit: "count", module: "pms", source: "reservations arriving today", drillTo: "/pms/arrivals", rising: "good", floor: 1 },
  { id: "unavailable", label: "Rooms not sellable", key: "unavailable_rooms", unit: "count", module: "housekeeping", source: "rooms blocked / out of order", drillTo: "/pms/rooms", rising: "bad", floor: 1 },
  { id: "overdue", label: "Overdue tasks", key: "overdue_tasks", unit: "count", module: "workforce", source: "tasks past due_at", drillTo: "/tasks", rising: "bad", floor: 1 },
  { id: "approvals", label: "Approvals waiting", key: "pending_approvals", unit: "count", module: "workforce", source: "approval_requests", drillTo: "/approvals", rising: "bad", floor: 1 },
  { id: "unposted", label: "Unposted eligible records", key: "unmatched_eligible", unit: "count", module: "finance", source: "neo_unmatched_facts", drillTo: "/finance/posting", rising: "bad", floor: 1 },
  { id: "events", label: "Confirmed event forecast", key: "event_confirmed_forecast", unit: "money", module: "events", source: "confirmed event bookings", drillTo: "/events", rising: "good", floor: 1 },
];

/** Material change threshold: 10% movement, or any movement of a control count. */
function isMaterial(spec: ChangeSpec, delta: number, deltaPercent: number | null): boolean {
  if (Math.abs(delta) < spec.floor) return false;
  if (spec.unit === "count") return true;
  if (deltaPercent === null) return true;
  return Math.abs(deltaPercent) >= 10;
}

export function buildChanges(
  current: IntelligencePayload | undefined,
  prior: IntelligencePayload | undefined,
): ChangeItem[] {
  if (!current || !prior) return [];
  const moneyVisible = current.money_visible === true;
  const items: ChangeItem[] = [];

  for (const spec of CHANGE_SPECS) {
    if (spec.unit === "money" && !moneyVisible) continue;
    const now = num(current, spec.key);
    const before = num(prior, spec.key);
    if (now === null && before === null) continue;
    const a = now ?? 0;
    const b = before ?? 0;
    const delta = a - b;
    const deltaPercent = b !== 0 ? (delta * 100) / Math.abs(b) : null;
    const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    const favourable: ChangeItem["favourable"] =
      direction === "flat"
        ? "neutral"
        : spec.rising === "neutral"
          ? "neutral"
          : (direction === "up") === (spec.rising === "good")
            ? "good"
            : "bad";
    items.push({
      id: spec.id,
      label: spec.label,
      current: now,
      previous: before,
      delta,
      deltaPercent,
      direction,
      material: isMaterial(spec, delta, deltaPercent),
      favourable,
      unit: spec.unit,
      modules: [spec.module],
      evidence: [
        {
          label: `${spec.label} — both periods`,
          source: spec.source,
          module: spec.module,
          drillTo: spec.drillTo,
        },
      ],
    });
  }

  return items.sort((a, b) => {
    if (a.material !== b.material) return a.material ? -1 : 1;
    return Math.abs(b.deltaPercent ?? 0) - Math.abs(a.deltaPercent ?? 0);
  });
}

/** Prior comparable window of exactly the same length, immediately before. */
export function priorPeriod(from: string, to: string): { from: string; to: string } {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  const span = Math.max(end - start, 0) + 86_400_000;
  const priorEnd = new Date(start - 86_400_000);
  const priorStart = new Date(start - span);
  return { from: priorStart.toISOString().slice(0, 10), to: priorEnd.toISOString().slice(0, 10) };
}

/* ------------------------------------------------------------------ *
 * Morning brief — the 3–4 most material things right now.
 * ------------------------------------------------------------------ */

export type BriefItem = {
  id: string;
  headline: string;
  detail: string;
  severity: Severity;
  modules: NeoModule[];
  drillTo?: string;
  investigate?: string;
};

export function buildBrief(
  discoveries: Discovery[],
  changes: ChangeItem[],
  limit = 4,
): BriefItem[] {
  const items: BriefItem[] = discoveries.slice(0, limit).map((d) => ({
    id: d.id,
    headline: d.title,
    detail: d.conclusion,
    severity: d.severity,
    modules: d.modules,
    ...(d.drillTo ? { drillTo: d.drillTo } : {}),
    ...(d.investigate ? { investigate: d.investigate } : {}),
  }));

  const material = changes.filter((c) => c.material && c.favourable === "bad");
  for (const c of material) {
    if (items.length >= limit) break;
    if (items.some((i) => i.id === c.id)) continue;
    items.push({
      id: `change-${c.id}`,
      headline: `${c.label} moved ${c.direction}`,
      detail: describeChange(c),
      severity: "warning",
      modules: c.modules,
      ...(c.evidence[0]?.drillTo ? { drillTo: c.evidence[0].drillTo } : {}),
    });
  }
  return items.slice(0, limit);
}

export function describeChange(c: ChangeItem): string {
  const fmt = (v: number | null) =>
    v === null ? "—" : c.unit === "percent" ? `${v.toFixed(1)}%` : new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(v);
  const pct = c.deltaPercent === null ? "" : ` (${c.deltaPercent > 0 ? "+" : ""}${c.deltaPercent.toFixed(1)}%)`;
  return `${fmt(c.previous)} → ${fmt(c.current)}${pct} against the immediately preceding comparable period.`;
}

/* ------------------------------------------------------------------ *
 * Decisions — prepared by NEØ, executed only by an authorised human.
 * ------------------------------------------------------------------ */

export function buildDecisions(payload: IntelligencePayload | undefined): Decision[] {
  if (!payload || payload.authorised === false) return [];
  const currency = payload.currency ?? "";
  const moneyVisible = payload.money_visible === true;
  const confidence: Confidence = payload.demand?.confidence ?? "insufficient";
  const sufficient = payload.demand?.sufficient === true;
  const out: Decision[] = [];

  for (const r of payload.rate_suggestions ?? []) {
    const pace =
      r.rooms_of_type > 0 ? (r.on_the_books_next_14 * 100) / (r.rooms_of_type * 14) : null;
    const evidence: Evidence[] = [
      {
        label: `${r.room_type} — reservations on the books (next 14 days)`,
        recordCount: r.on_the_books_next_14,
        source: "reservations vs sellable rooms of this type",
        module: "pms",
        drillTo: "/pms/availability",
      },
      {
        label: `${r.rate_plan ?? "No active plan"} — published rate`,
        source: "rate_plans",
        module: "pms",
        drillTo: "/rates",
      },
    ];

    const scenario =
      moneyVisible && r.current_rate !== null && r.rooms_of_type > 0
        ? {
            label: "Deterministic scenario",
            inputs: [
              { label: "Published rate", value: formatMoney(r.current_rate, currency) },
              { label: "Rooms of type", value: String(r.rooms_of_type) },
              { label: "On the books (14d)", value: String(r.on_the_books_next_14) },
            ],
            outputs: [
              {
                label: "Value of nights already on the books",
                value: formatMoney(r.current_rate * r.on_the_books_next_14, currency),
              },
              {
                label: "Value if every sellable night of this type sold",
                value: formatMoney(r.current_rate * r.rooms_of_type * 14, currency),
              },
            ],
            method:
              "Arithmetic on the published rate and recorded room counts only. This is not a forecast and assumes no rate change or cancellation.",
          }
        : undefined;

    out.push({
      id: `rate-${r.room_type}-${r.rate_plan ?? "none"}`,
      headline: `${r.room_type} — review the published rate against booking pace`,
      kind: sufficient ? "recommendation" : "observation",
      why:
        pace === null
          ? "No sellable rooms of this type are recorded, so pace cannot be computed."
          : `Reservations on the books cover ${pace.toFixed(0)}% of this room type's sellable nights over the next 14 days.`,
      evidence,
      confidence,
      confidenceNote: sufficient
        ? `${payload.demand?.sample_days ?? 0} day(s) of recorded occupancy support this comparison.`
        : `Only ${payload.demand?.sample_days ?? 0} day(s) of occupancy are recorded, so NEØ shows booking pace as evidence and refuses to present a statistical forecast.`,
      impact: scenario
        ? `Recorded value of nights already on the books: ${scenario.outputs[0]?.value}.`
        : "Impact not quantified — finance visibility or a published rate is missing.",
      alternatives: [
        "Hold the published rate and review again after the next pace update.",
        "Prepare a rate change for an authorised approver in Rates.",
        "Release held or blocked rooms of this type before changing price.",
      ],
      action: { label: "Open Rates", to: "/rates", requiresAuthorisation: true },
      ...(scenario ? { scenario } : {}),
    });
  }

  const unposted = num(payload, "unmatched_eligible") ?? 0;
  if (unposted > 0) {
    out.push({
      id: "decision-posting",
      headline: "Clear the Finance posting backlog before period close",
      kind: "recommendation",
      why: `${unposted} eligible operational record(s) have no matching posting, so recognised revenue in this period is understated by whatever those records represent.`,
      evidence: [
        {
          label: "Eligible records without a posting",
          recordCount: unposted,
          source: "neo_unmatched_facts",
          module: "finance",
          drillTo: "/finance/posting",
        },
      ],
      confidence: "high",
      confidenceNote: "Counted directly from reconciliation records.",
      impact: "Impact not quantified — the monetary value of unposted records is not attributed here.",
      alternatives: [
        "Post the eligible records through the existing posting engine.",
        "Record an explanation for records that are deliberately excluded.",
      ],
      action: { label: "Open Finance posting", to: "/finance/posting", requiresAuthorisation: true },
    });
  }

  const uncosted = (payload.menu?.items_total ?? 0) - (payload.menu?.items_costed ?? 0);
  if (uncosted > 0) {
    out.push({
      id: "decision-recipes",
      headline: "Cost the remaining menu items so margin can be analysed",
      kind: "recommendation",
      why: `${uncosted} menu item(s) have no costed recipe. NEØ will not estimate their margin, so those items are invisible to profitability analysis.`,
      evidence: [
        {
          label: "Menu items without a costed recipe",
          recordCount: uncosted,
          source: "menu_items joined to recipe cost",
          module: "kitchen",
          drillTo: "/kitchen/recipes",
        },
      ],
      confidence: "high",
      confidenceNote: "Counted directly from menu and recipe records.",
      impact: "Impact not quantified until recipes are costed.",
      alternatives: ["Cost the highest-selling uncosted items first.", "Retire items that are no longer sold."],
      action: { label: "Open Recipes", to: "/kitchen/recipes", requiresAuthorisation: true },
    });
  }

  return out;
}

/** Deterministic occupancy scenario: no statistics, only arithmetic. */
export function simulateOccupancy(
  sellableRooms: number | null,
  targetOccupancyPercent: number,
  averageRate: number | null,
): { rooms: number | null; value: number | null; method: string } {
  const method =
    "Sellable rooms × target occupancy, valued at the supplied average rate. Arithmetic only — no demand forecast is implied.";
  if (sellableRooms === null || sellableRooms <= 0) return { rooms: null, value: null, method };
  const rooms = Math.round((sellableRooms * targetOccupancyPercent) / 100);
  return { rooms, value: averageRate === null ? null : Math.round(rooms * averageRate), method };
}

/* ------------------------------------------------------------------ *
 * Investigations — break one issue into contributing groups.
 * ------------------------------------------------------------------ */

export function buildInvestigation(
  topic: string,
  payload: IntelligencePayload | undefined,
  scope: Scope,
): Investigation | null {
  if (!payload || payload.authorised === false) return null;

  if (topic === "rooms-unavailable") {
    const unavailable = num(payload, "unavailable_rooms");
    const sellable = num(payload, "sellable_rooms");
    return {
      topic,
      title: "Why rooms are not sellable",
      summary:
        unavailable === null
          ? "Room availability is not recorded for this scope."
          : `${unavailable} room(s) are excluded from sale against ${sellable ?? "—"} sellable room(s).`,
      scope,
      groups: [
        {
          label: "Recorded as unavailable",
          value: unavailable,
          note: "Blocked, out of service or out of order in room records.",
          drillTo: "/pms/rooms",
        },
        {
          label: "Housekeeping work in hand",
          value: null,
          note: "A dirty / inspected-not-released split is not exposed by the intelligence payload, so NEØ will not invent one. Open Housekeeping for the live board.",
          drillTo: "/housekeeping",
        },
      ],
      drivers: [
        { kind: "fact", text: `${unavailable ?? 0} room(s) are recorded as not sellable in this property.` },
        {
          kind: "limitation",
          text: "The reason breakdown (dirty, inspected-not-released, maintenance, manually blocked) is not available in this payload and is therefore not asserted.",
        },
      ],
      evidence: [
        { label: "Rooms not sellable", recordCount: unavailable, source: "rooms + ops_room_state", module: "pms", drillTo: "/pms/rooms" },
        { label: "Sellable rooms", recordCount: sellable, source: "rooms in scope", module: "pms", drillTo: "/pms/availability" },
      ],
      modules: ["pms", "housekeeping"],
      actions: [
        { label: "See room records", to: "/pms/rooms" },
        { label: "Open Housekeeping", to: "/housekeeping" },
        { label: "Open Availability", to: "/pms/availability" },
      ],
    };
  }

  if (topic === "finance-unposted") {
    const unposted = num(payload, "unmatched_eligible");
    const failed = num(payload, "failed_postings");
    return {
      topic,
      title: "Why Finance is behind",
      summary: `${unposted ?? 0} eligible record(s) unposted and ${failed ?? 0} failed posting attempt(s).`,
      scope,
      groups: [
        { label: "Eligible but unposted", value: unposted, note: "Operational records with no matching posting.", drillTo: "/finance/posting" },
        { label: "Failed posting attempts", value: failed, note: "Require an authorised recovery action.", drillTo: "/finance/posting" },
      ],
      drivers: [
        { kind: "fact", text: `${unposted ?? 0} eligible operational record(s) have no matching Finance posting.` },
        { kind: "fact", text: `${failed ?? 0} posting attempt(s) failed.` },
        { kind: "recommendation", text: "Replay failed postings through the existing idempotent posting engine; no posting is performed by Intelligence." },
      ],
      evidence: [
        { label: "Unposted eligible records", recordCount: unposted, source: "neo_unmatched_facts", module: "finance", drillTo: "/finance/posting" },
        { label: "Failed posting receipts", recordCount: failed, source: "finance_posting_receipts", module: "finance", drillTo: "/finance/posting" },
      ],
      modules: ["finance", "pos", "pms"],
      actions: [
        { label: "See records", to: "/finance/posting" },
        { label: "Open Finance", to: "/finance" },
      ],
    };
  }

  if (topic === "menu-uncosted") {
    const total = payload.menu?.items_total ?? 0;
    const costed = payload.menu?.items_costed ?? 0;
    return {
      topic,
      title: "Which menu items cannot be analysed yet",
      summary: `${total - costed} of ${total} menu item(s) have no costed recipe.`,
      scope,
      groups: [
        { label: "Costed and analysable", value: costed, note: "Both a price and a costed recipe exist.", drillTo: "/kitchen/recipes" },
        { label: "Not analysable", value: total - costed, note: "No costed recipe — margin is never estimated.", drillTo: "/pos/menu" },
      ],
      drivers: [
        { kind: "calculation", text: `Coverage is ${payload.menu?.coverage_percent ?? "—"}% of menu items.` },
        { kind: "limitation", text: "Margin for uncosted items is not reported at all, rather than estimated." },
      ],
      evidence: [
        { label: "Menu items", recordCount: total, source: "menu_items", module: "pos", drillTo: "/pos/menu" },
        { label: "Costed recipes", recordCount: costed, source: "recipe cost records", module: "kitchen", drillTo: "/kitchen/recipes" },
      ],
      modules: ["kitchen", "pos", "inventory"],
      actions: [
        { label: "Open Recipes", to: "/kitchen/recipes" },
        { label: "Open Menu", to: "/pos/menu" },
      ],
    };
  }

  if (topic === "booking-pace") {
    const fwd = payload.demand?.forward ?? [];
    const books = fwd.reduce((s, d) => s + Number(d.on_the_books ?? 0), 0);
    const sellable = fwd.reduce((s, d) => s + Number(d.sellable ?? 0), 0);
    return {
      topic,
      title: "Forward booking pace",
      summary:
        sellable > 0
          ? `${books} reservation night(s) on the books against ${sellable} sellable night(s) over the next 14 days.`
          : "No sellable forward inventory is recorded.",
      scope,
      groups: fwd.slice(0, 14).map((d) => ({
        label: String(d.day),
        value: Number(d.on_the_books ?? 0),
        note: `${Number(d.sellable ?? 0)} sellable`,
        drillTo: "/pms/availability",
      })),
      drivers: [
        { kind: "calculation", text: sellable > 0 ? `Pace is ${((books * 100) / sellable).toFixed(0)}% of sellable nights.` : "Pace cannot be computed without sellable inventory." },
        { kind: "limitation", text: "Booking pace is recorded demand, not a statistical forecast." },
      ],
      evidence: [
        { label: "Reservation nights on the books", recordCount: books, source: "reservations by arrival date", module: "pms", drillTo: "/pms/reservations" },
        { label: "Sellable nights", recordCount: sellable, source: "sellable rooms per day", module: "pms", drillTo: "/pms/availability" },
      ],
      modules: ["pms", "crm", "events"],
      actions: [
        { label: "Open Availability", to: "/pms/availability" },
        { label: "See reservations", to: "/pms/reservations" },
      ],
    };
  }

  return null;
}

/** A visual built from the payload's recorded demand history. */
export function occupancyVisualization(payload: IntelligencePayload | undefined): Visualization | null {
  const history = payload?.demand?.history ?? [];
  if (history.length === 0) return null;
  return {
    kind: "area",
    title: "Occupancy by day",
    xKey: "day",
    unit: "percent",
    series: [{ key: "occupancy", label: "Occupancy %" }],
    data: history.map((p) => ({ day: String(p.day).slice(5), occupancy: p.occupancy ?? null })),
  };
}

export function statement(kind: Statement["kind"], text: string): Statement {
  return { kind, text };
}

/* ------------------------------------------------------------------ *
 * Positives — what is going well, on the same evidence as the risks.
 *
 * Intelligence must not read as a permanent complaint. These items are
 * derived from exactly the same scoped payload and comparison window as the
 * findings: favourable material movements, and clean control states that are
 * only stated when the records actually show them.
 * ------------------------------------------------------------------ */

export type Positive = {
  id: string;
  headline: string;
  detail: string;
  modules: NeoModule[];
  drillTo?: string;
};

export function buildPositives(
  payload: IntelligencePayload | undefined,
  changes: ChangeItem[],
  discoveries: Discovery[] = [],
): Positive[] {
  if (!payload) return [];
  const items: Positive[] = [];

  for (const c of changes) {
    if (!c.material || c.favourable !== "good") continue;
    items.push({
      id: `up-${c.id}`,
      headline: `${c.label} improved`,
      detail: describeChange(c),
      modules: c.modules,
      ...(c.evidence[0]?.drillTo ? { drillTo: c.evidence[0].drillTo } : {}),
    });
  }

  const clean = (
    key: string,
    headline: string,
    detail: string,
    modules: NeoModule[],
    drillTo?: string,
  ) => {
    const value = num(payload, key);
    if (value !== 0) return;
    items.push({ id: `clean-${key}`, headline, detail, modules, ...(drillTo ? { drillTo } : {}) });
  };

  clean("overdue_tasks", "No overdue work", "Every task in this scope is inside its due time.", ["workforce"], "/tasks");
  clean("pending_approvals", "Approvals are clear", "Nothing is waiting on an approver in this scope.", ["workforce"], "/approvals");
  clean("unmatched_eligible", "Finance is fully posted", "Every eligible operational record in this period has reached the ledger.", ["finance"], "/finance/posting");
  clean("unavailable_rooms", "Every room is sellable", "No room is blocked or out of order in this scope.", ["housekeeping"], "/pms/rooms");

  const rating = payload.sentiment?.average_rating ?? null;
  const responses = payload.sentiment?.responses ?? 0;
  if (rating !== null && responses > 0 && rating >= 4) {
    items.push({
      id: "guest-rating",
      headline: `Guests rated ${rating.toFixed(2)} out of 5`,
      detail: `Across ${responses} response(s) recorded in this period.`,
      modules: ["crm"],
      drillTo: "/crm",
    });
  }

  if (discoveries.length === 0 && items.length > 0) {
    items.push({
      id: "no-findings",
      headline: "No detection rule matched",
      detail:
        "Nothing in this property and period triggered a risk rule. That is what the records show, not a guarantee.",
      modules: ["finance"],
    });
  }

  return items;
}
