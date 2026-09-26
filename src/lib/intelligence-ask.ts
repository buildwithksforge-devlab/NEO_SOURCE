/**
 * Ask NEØ — grounded question answering.
 *
 * The answer is produced deterministically from the already-authorised
 * `neo_intelligence` payload for the signed-in user's scope. A language model,
 * when one is configured, may only rephrase this answer: it never chooses the
 * numbers and never adds a figure of its own. When the records cannot answer
 * the question, NEØ says so and names what is missing.
 */
import type { IntelligencePayload } from "@/lib/intelligence-data";
import type {
  Confidence,
  Driver,
  Evidence,
  GroundedAnswer,
  NeoModule,
  Scope,
  Statement,
  Visualization,
} from "@/lib/intelligence-types";
import { buildChanges, describeChange, num, occupancyVisualization } from "@/lib/intelligence-engine";

export type AskContext = {
  payload: IntelligencePayload | undefined;
  prior?: IntelligencePayload | undefined;
  scope: Scope;
};

export type Topic =
  | "revenue"
  | "occupancy"
  | "rooms"
  | "finance"
  | "pos"
  | "guest"
  | "menu"
  | "work"
  | "events"
  | "receivables"
  | "pace"
  | "changes"
  | "workforce"
  | "unknown";

const MATCHERS: { topic: Topic; patterns: RegExp[] }[] = [
  { topic: "changes", patterns: [/what.*chang/i, /compare/i, /versus|vs\b/i, /last (week|month|period)/i, /better or worse/i] },
  { topic: "revenue", patterns: [/revenue/i, /turnover/i, /how much did we (make|earn)/i, /sales total/i] },
  { topic: "occupancy", patterns: [/occupanc/i, /room nights/i, /how full/i] },
  { topic: "rooms", patterns: [/rooms? (not )?(sellable|available)/i, /out of order/i, /blocked rooms?/i, /unavailable/i, /why.*rooms/i] },
  { topic: "finance", patterns: [/post(ing|ed)/i, /unposted/i, /reconcil/i, /ledger/i, /journal/i, /close the (books|period)/i] },
  { topic: "pos", patterns: [/\bpos\b/i, /restaurant/i, /bar\b/i, /open (orders|bills|tabs)/i, /point of sale/i] },
  { topic: "guest", patterns: [/guest/i, /feedback/i, /rating/i, /complaint/i, /satisfaction/i, /review/i] },
  { topic: "menu", patterns: [/menu/i, /margin/i, /recipe/i, /food cost/i, /profitab/i] },
  { topic: "work", patterns: [/task/i, /overdue/i, /approval/i, /workflow/i, /backlog/i] },
  { topic: "events", patterns: [/event/i, /banquet/i, /function/i, /conferenc/i] },
  { topic: "receivables", patterns: [/receivab/i, /debtor/i, /owed/i, /outstanding balance/i, /credit/i] },
  { topic: "pace", patterns: [/pace/i, /on the books/i, /forecast/i, /next (14|two weeks|fortnight)/i, /forward/i, /pickup/i] },
  { topic: "workforce", patterns: [/staff/i, /roster/i, /shift/i, /attendance/i, /workforce/i, /coverage/i] },
];

export function classifyQuestion(question: string): Topic {
  for (const m of MATCHERS) if (m.patterns.some((p) => p.test(question))) return m.topic;
  return "unknown";
}

export const SUGGESTED_QUESTIONS = [
  "What changed since the previous period?",
  "Why are rooms not sellable right now?",
  "How is our forward booking pace?",
  "What is blocking Finance from closing?",
  "Which menu items can we not analyse?",
  "What did guests rate us this period?",
];

const fmtMoney = (v: number | null, currency: string, visible: boolean): string => {
  if (!visible) return "not visible to you";
  if (v === null) return "—";
  return `${currency ? `${currency} ` : ""}${new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(v)}`;
};

const fmtCount = (v: number | null): string => (v === null ? "—" : String(Math.round(v)));

/**
 * Contextual next questions per topic. They are ordinary questions, so each one
 * is answered by the same deterministic path — nothing here is a special case.
 */
const FOLLOW_UPS: Record<Topic, string[]> = {
  revenue: ["What changed since the previous period?", "How is our forward booking pace?", "What is blocking Finance from closing?"],
  occupancy: ["How is our forward booking pace?", "Why are rooms not sellable right now?", "What changed since the previous period?"],
  rooms: ["What is our occupancy this period?", "How is our forward booking pace?"],
  finance: ["What is outstanding from debtors?", "Are there open POS bills?", "What changed since the previous period?"],
  pos: ["Which menu items can we not analyse?", "What is blocking Finance from closing?"],
  guest: ["What did guests rate us this period?", "What changed since the previous period?"],
  menu: ["Which menu items can we not analyse?", "Are there open POS bills?"],
  work: ["What approvals are waiting?", "What changed since the previous period?"],
  events: ["What is our occupancy this period?", "How is our forward booking pace?"],
  receivables: ["What is blocking Finance from closing?", "Are there open POS bills?"],
  pace: ["What is our occupancy this period?", "What changed since the previous period?"],
  changes: ["What is our occupancy this period?", "What is blocking Finance from closing?", "How is our forward booking pace?"],
  workforce: ["What overdue tasks are open?", "What approvals are waiting?"],
  unknown: SUGGESTED_QUESTIONS.slice(0, 3),
};

/** Contextual actions offered beneath an answer. Pure lookup, no invention. */
export function followUpsFor(topic: string): string[] {
  return FOLLOW_UPS[(topic as Topic) in FOLLOW_UPS ? (topic as Topic) : "unknown"] ?? [];
}

function base(
  question: string,
  topic: Topic,
  ctx: AskContext,
  parts: {
    headline: string;
    statements: Statement[];
    evidence: Evidence[];
    modules: NeoModule[];
    visualization?: Visualization | null;
    confidence?: Confidence;
    limitation?: string | null;
    drivers?: Driver[];
  },
): GroundedAnswer {
  return {
    topic,
    question,
    headline: parts.headline,
    statements: parts.statements,
    evidence: parts.evidence,
    modules: parts.modules,
    visualization: parts.visualization ?? null,
    confidence: parts.confidence ?? "high",
    scope: ctx.scope,
    limitation: parts.limitation ?? null,
    drivers: parts.drivers ?? [],
    followUps: followUpsFor(topic),
  };
}

/** Deterministic, scope-bound answer. Never fabricates a value. */
export function answerQuestion(question: string, ctx: AskContext): GroundedAnswer {
  const p = ctx.payload;
  const topic = classifyQuestion(question);

  if (!p || p.authorised === false) {
    return base(question, topic, ctx, {
      headline: "NEØ cannot answer this in your current scope",
      statements: [
        {
          kind: "limitation",
          text:
            p?.reason === "insufficient_capability"
              ? "You do not hold a capability that allows intelligence for this property."
              : "No authorised intelligence payload is available for this property and period.",
        },
      ],
      evidence: [],
      modules: [],
      confidence: "insufficient",
      limitation: "Answer withheld — scope or capability does not permit it.",
    });
  }

  const currency = p.currency ?? "";
  const moneyVisible = p.money_visible === true;

  switch (topic) {
    case "revenue": {
      const rev = num(p, "net_recognised_revenue");
      const pos = num(p, "pos_finalised_sales");
      const collected = num(p, "collected");
      if (!moneyVisible) {
        return base(question, topic, ctx, {
          headline: "Monetary values are not visible to you",
          statements: [{ kind: "limitation", text: "Your capabilities do not include finance visibility, so NEØ will not disclose monetary values." }],
          evidence: [],
          modules: ["finance"],
          confidence: "insufficient",
          limitation: "Finance visibility required.",
        });
      }
      return base(question, topic, ctx, {
        headline: `Recognised revenue is ${fmtMoney(rev, currency, true)} for ${ctx.scope.from} to ${ctx.scope.to}`,
        statements: [
          { kind: "fact", text: `Recognised revenue: ${fmtMoney(rev, currency, true)}.` },
          { kind: "fact", text: `Finalised point-of-sale sales: ${fmtMoney(pos, currency, true)}.` },
          { kind: "fact", text: `Collected: ${fmtMoney(collected, currency, true)}.` },
          { kind: "limitation", text: "Revenue is recognised from posted journals only. Unposted operational records are excluded until they post." },
        ],
        evidence: [
          { label: "Recognised revenue", source: "posted journals net of reversals", module: "finance", drillTo: "/finance/journals" },
          { label: "Finalised POS sales", source: "settled pos_orders", module: "pos", drillTo: "/pos/orders" },
          { label: "Collections", source: "recorded payments", module: "finance", drillTo: "/finance/payments" },
        ],
        modules: ["finance", "pos", "pms"],
        visualization: { kind: "metric", title: "Recognised revenue", value: fmtMoney(rev, currency, true), hint: "Posted journals only" },
      });
    }

    case "occupancy": {
      const occ = num(p, "occupancy_rate");
      const sample = p.demand?.sample_days ?? 0;
      return base(question, topic, ctx, {
        headline: occ === null ? "Occupancy is not recorded for this period" : `Occupancy is ${occ}% across the period`,
        statements: [
          { kind: "fact", text: `Occupancy rate: ${occ === null ? "not recorded" : `${occ}%`}.` },
          { kind: "fact", text: `Sellable rooms: ${fmtCount(num(p, "sellable_rooms"))}; not sellable: ${fmtCount(num(p, "unavailable_rooms"))}.` },
          { kind: "calculation", text: p.demand?.method ?? "Occupied room nights divided by sellable rooms." },
          ...(sample < 14 ? [{ kind: "limitation" as const, text: `Only ${sample} day(s) of occupancy are recorded, so trend confidence is low.` }] : []),
        ],
        evidence: [
          { label: "Occupied room nights", source: "ops_room_state / reservations", module: "pms", drillTo: "/pms/availability" },
          { label: "Sellable rooms", recordCount: num(p, "sellable_rooms"), source: "rooms in scope", module: "pms", drillTo: "/pms/rooms" },
        ],
        modules: ["pms", "housekeeping"],
        visualization: occupancyVisualization(p),
        confidence: p.demand?.confidence ?? "insufficient",
      });
    }

    case "rooms": {
      const unavailable = num(p, "unavailable_rooms");
      const sellable = num(p, "sellable_rooms");
      return base(question, topic, ctx, {
        headline: `${fmtCount(unavailable)} room(s) are not sellable, against ${fmtCount(sellable)} sellable`,
        statements: [
          { kind: "fact", text: `${fmtCount(unavailable)} room(s) are blocked, out of service or out of order.` },
          { kind: "limitation", text: "The reason split (dirty, awaiting inspection, maintenance, manually blocked) is not exposed here, so NEØ does not assert one. Housekeeping holds the live board." },
        ],
        evidence: [
          { label: "Rooms not sellable", recordCount: unavailable, source: "rooms + ops_room_state", module: "pms", drillTo: "/pms/rooms" },
          { label: "Housekeeping board", source: "housekeeping jobs", module: "housekeeping", drillTo: "/housekeeping" },
        ],
        modules: ["pms", "housekeeping"],
        visualization: {
          kind: "bar",
          title: "Room availability",
          xKey: "state",
          series: [{ key: "rooms", label: "Rooms" }],
          data: [
            { state: "Sellable", rooms: sellable },
            { state: "Not sellable", rooms: unavailable },
          ],
        },
      });
    }

    case "finance": {
      const unposted = num(p, "unmatched_eligible");
      const failed = num(p, "failed_postings");
      return base(question, topic, ctx, {
        headline: `${fmtCount(unposted)} eligible record(s) unposted and ${fmtCount(failed)} failed posting attempt(s)`,
        statements: [
          { kind: "fact", text: `${fmtCount(unposted)} eligible operational record(s) have no matching Finance posting.` },
          { kind: "fact", text: `${fmtCount(failed)} posting attempt(s) failed.` },
          { kind: "recommendation", text: "Clear both before period close. Intelligence never posts, retries or reverses anything itself." },
        ],
        evidence: [
          { label: "Unposted eligible records", recordCount: unposted, source: "neo_unmatched_facts", module: "finance", drillTo: "/finance/posting" },
          { label: "Failed posting receipts", recordCount: failed, source: "finance_posting_receipts", module: "finance", drillTo: "/finance/posting" },
        ],
        modules: ["finance", "pos", "pms"],
      });
    }

    case "pos": {
      const open = num(p, "pos_open_value");
      const sales = num(p, "pos_finalised_sales");
      return base(question, topic, ctx, {
        headline: moneyVisible
          ? `${fmtMoney(sales, currency, true)} finalised, ${fmtMoney(open, currency, true)} still open`
          : "Point-of-sale activity is recorded, but monetary values are not visible to you",
        statements: [
          { kind: "fact", text: `Finalised point-of-sale sales: ${fmtMoney(sales, currency, moneyVisible)}.` },
          { kind: "fact", text: `Open point-of-sale value: ${fmtMoney(open, currency, moneyVisible)}.` },
        ],
        evidence: [
          { label: "Settled orders", source: "pos_orders (settled)", module: "pos", drillTo: "/pos/orders" },
          { label: "Open orders", source: "pos_orders still in service", module: "pos", drillTo: "/pos/orders" },
        ],
        modules: ["pos", "kitchen", "finance"],
      });
    }

    case "guest": {
      const responses = p.sentiment?.responses ?? 0;
      if (responses === 0) {
        return base(question, topic, ctx, {
          headline: "No guest feedback was submitted in this period",
          statements: [{ kind: "limitation", text: "Sentiment is only reported from feedback records actually received. Nothing is inferred from other data." }],
          evidence: [{ label: "Guest feedback", recordCount: 0, source: "submitted feedback", module: "crm", drillTo: "/crm/feedback" }],
          modules: ["crm"],
          confidence: "insufficient",
          limitation: "No feedback records exist for this scope.",
        });
      }
      return base(question, topic, ctx, {
        headline: `${responses} rating(s) received, averaging ${p.sentiment?.average_rating ?? "—"}`,
        statements: [
          { kind: "fact", text: `${responses} guest rating(s) submitted; ${p.sentiment?.detractors ?? 0} were 2 or below.` },
          { kind: "calculation", text: p.sentiment?.note ?? "Derived arithmetically from submitted ratings." },
        ],
        evidence: [{ label: "Guest ratings", recordCount: responses, source: "guest feedback records", module: "crm", drillTo: "/crm/feedback" }],
        modules: ["crm", "housekeeping", "pos"],
        visualization: {
          kind: "bar",
          title: "Feedback by theme",
          xKey: "category",
          series: [{ key: "responses", label: "Responses" }],
          data: (p.sentiment?.themes ?? []).map((t) => ({ category: t.category, responses: t.responses })),
        },
        confidence: responses >= 20 ? "high" : "moderate",
      });
    }

    case "menu": {
      const total = p.menu?.items_total ?? 0;
      const costed = p.menu?.items_costed ?? 0;
      return base(question, topic, ctx, {
        headline: `${costed} of ${total} menu item(s) can be analysed for margin`,
        statements: [
          { kind: "calculation", text: `Cost coverage is ${p.menu?.coverage_percent ?? "—"}% of menu items.` },
          { kind: "limitation", text: "Items without a costed recipe are reported as missing coverage. NEØ never estimates a margin." },
        ],
        evidence: [
          { label: "Menu items", recordCount: total, source: "menu_items", module: "pos", drillTo: "/pos/menu" },
          { label: "Costed recipes", recordCount: costed, source: "recipe cost records", module: "kitchen", drillTo: "/kitchen/recipes" },
        ],
        modules: ["kitchen", "pos", "inventory"],
        visualization: {
          kind: "table",
          title: "Costed items",
          columns: [
            { key: "item", label: "Item" },
            { key: "margin", label: "Margin %" },
          ],
          rows: (p.menu?.items ?? []).slice(0, 10).map((m) => ({ item: m.item, margin: m.margin_percent })),
        },
      });
    }

    case "work": {
      return base(question, topic, ctx, {
        headline: `${fmtCount(num(p, "overdue_tasks"))} overdue task(s) and ${fmtCount(num(p, "pending_approvals"))} approval(s) waiting`,
        statements: [
          { kind: "fact", text: `${fmtCount(num(p, "overdue_tasks"))} task(s) are past due.` },
          { kind: "fact", text: `${fmtCount(num(p, "pending_approvals"))} approval request(s) are pending or executing.` },
          { kind: "fact", text: `${fmtCount(num(p, "failed_workflows"))} automation workflow(s) failed and are unresolved.` },
        ],
        evidence: [
          { label: "Overdue tasks", recordCount: num(p, "overdue_tasks"), source: "tasks past due_at", module: "workforce", drillTo: "/tasks" },
          { label: "Approvals waiting", recordCount: num(p, "pending_approvals"), source: "approval_requests", module: "workforce", drillTo: "/approvals" },
        ],
        modules: ["workforce", "finance", "housekeeping"],
      });
    }

    case "events": {
      const confirmed = num(p, "event_confirmed_forecast");
      const provisional = num(p, "event_provisional_forecast");
      return base(question, topic, ctx, {
        headline: moneyVisible
          ? `${fmtMoney(confirmed, currency, true)} confirmed event value in scope`
          : "Event bookings are recorded, but monetary values are not visible to you",
        statements: [
          { kind: "fact", text: `Confirmed event value: ${fmtMoney(confirmed, currency, moneyVisible)}.` },
          { kind: "fact", text: `Provisional event value: ${fmtMoney(provisional, currency, moneyVisible)}.` },
          { kind: "limitation", text: "Provisional value is not revenue and is never added to recognised revenue." },
        ],
        evidence: [{ label: "Event bookings", source: "event bookings by status", module: "events", drillTo: "/events" }],
        modules: ["events", "finance"],
      });
    }

    case "receivables": {
      return base(question, topic, ctx, {
        headline: moneyVisible ? `${fmtMoney(num(p, "receivables"), currency, true)} receivable` : "Monetary values are not visible to you",
        statements: [
          { kind: "fact", text: `Receivables: ${fmtMoney(num(p, "receivables"), currency, moneyVisible)}.` },
          { kind: "fact", text: `Payables: ${fmtMoney(num(p, "payables"), currency, moneyVisible)}.` },
        ],
        evidence: [
          { label: "Receivables", source: "receivables ledger", module: "finance", drillTo: "/finance/receivables" },
          { label: "Payables", source: "approved supplier obligations", module: "procurement", drillTo: "/finance/payables" },
        ],
        modules: ["finance", "procurement"],
      });
    }

    case "pace": {
      const fwd = p.demand?.forward ?? [];
      const books = fwd.reduce((s, d) => s + Number(d.on_the_books ?? 0), 0);
      const sellable = fwd.reduce((s, d) => s + Number(d.sellable ?? 0), 0);
      return base(question, topic, ctx, {
        headline:
          sellable > 0
            ? `${books} night(s) on the books against ${sellable} sellable night(s) over the next 14 days`
            : "No forward sellable inventory is recorded",
        statements: [
          { kind: "fact", text: `${books} reservation night(s) are on the books for the next 14 days.` },
          ...(sellable > 0
            ? [{ kind: "calculation" as const, text: `That is ${((books * 100) / sellable).toFixed(0)}% of sellable nights.` }]
            : []),
          { kind: "limitation", text: "This is recorded booking pace, not a statistical forecast. NEØ does not model future demand." },
        ],
        evidence: [
          { label: "Forward reservations", recordCount: books, source: "reservations by arrival date", module: "pms", drillTo: "/pms/reservations" },
          { label: "Sellable nights", recordCount: sellable, source: "sellable rooms per day", module: "pms", drillTo: "/pms/availability" },
        ],
        modules: ["pms", "crm", "events"],
        visualization: {
          kind: "line",
          title: "Next 14 days on the books",
          xKey: "day",
          series: [
            { key: "onBooks", label: "On the books" },
            { key: "sellable", label: "Sellable" },
          ],
          data: fwd.map((d) => ({ day: String(d.day).slice(5), onBooks: Number(d.on_the_books ?? 0), sellable: Number(d.sellable ?? 0) })),
        },
        confidence: p.demand?.confidence ?? "insufficient",
      });
    }

    case "changes": {
      const changes = buildChanges(p, ctx.prior);
      if (changes.length === 0) {
        return base(question, topic, ctx, {
          headline: "No comparable prior period is available",
          statements: [{ kind: "limitation", text: "A comparison needs the immediately preceding period of equal length; it has not been loaded or holds no records." }],
          evidence: [],
          modules: [],
          confidence: "insufficient",
          limitation: "No prior-period records to compare with.",
        });
      }
      const material = changes.filter((c) => c.material).slice(0, 6);
      const shown = material.length > 0 ? material : changes.slice(0, 4);
      const numeric = shown.filter((c) => c.delta !== null && c.unit !== "money");
      return base(question, topic, ctx, {
        headline: material.length === 0 ? "Nothing moved materially against the prior period" : `${material.length} material change(s) against the prior period`,
        statements: shown.map((c) => ({
          kind: "comparison" as const,
          text: `${c.label}: ${describeChange(c)}`,
        })),
        evidence: shown.flatMap((c) => c.evidence),
        modules: Array.from(new Set((material.length > 0 ? material : changes).flatMap((c) => c.modules))),
        drivers: shown.map((c) => ({
          label: c.label,
          value: c.deltaPercent === null ? (c.current === null ? "—" : String(c.current)) : `${c.deltaPercent > 0 ? "+" : ""}${c.deltaPercent.toFixed(1)}%`,
          direction: c.direction,
          favourable: c.favourable,
        })),
        visualization:
          numeric.length > 0
            ? {
                kind: "waterfall",
                title: "What moved, and by how much",
                steps: numeric.map((c) => ({ label: c.label, value: Number(c.delta) })),
                note: "Each bar is the recorded movement against the immediately preceding period of equal length. Movements that cannot be attributed are not shown.",
              }
            : null,
      });
    }

    case "workforce": {
      return base(question, topic, ctx, {
        headline: "Rostered workforce coverage is not reported by Intelligence",
        statements: [
          { kind: "fact", text: `${fmtCount(num(p, "overdue_tasks"))} overdue task(s) and ${fmtCount(num(p, "pending_approvals"))} approval(s) waiting are the only workload signals available here.` },
          { kind: "limitation", text: "Shift, attendance and station coverage are not part of the intelligence payload, so NEØ does not estimate them." },
        ],
        evidence: [{ label: "Work in hand", recordCount: num(p, "overdue_tasks"), source: "tasks past due_at", module: "workforce", drillTo: "/tasks" }],
        modules: ["workforce"],
        confidence: "insufficient",
        limitation: "Workforce scheduling records are not exposed to Intelligence.",
      });
    }

    default:
      return base(question, "unknown", ctx, {
        headline: "NEØ cannot answer that from the records it can see",
        statements: [
          {
            kind: "limitation",
            text: "This question does not map to any operational record set NEØ is permitted to read in this scope. Nothing was guessed.",
          },
        ],
        evidence: [],
        modules: [],
        confidence: "insufficient",
        limitation: "Question is outside the grounded record set. Try one of the suggested questions.",
      });
  }
}

/** Compact fact list handed to the language model when one is configured. */
export function answerFacts(answer: GroundedAnswer): { label: string; value: string }[] {
  return answer.statements.map((s, i) => ({ label: `${s.kind} ${i + 1}`, value: s.text }));
}
