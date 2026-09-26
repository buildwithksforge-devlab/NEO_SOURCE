/**
 * Ask NEØ — departmental brain.
 *
 * Senior roles open the whole Intelligence surface. Everybody else asks NEØ the
 * same way, but the answer is composed only from `neo_my_work`, which the
 * database already filtered to the modules the signed-in person's effective
 * permissions reach, in the property the header is working in.
 *
 * NEØ never invents a figure here. When a question reaches past the asker's
 * permissions, past the current property, or into money they may not see, the
 * answer says so plainly and names nothing.
 */
import type { WorkItem } from "@/lib/my-work";

export type DepartmentAnswerKind = "answered" | "nothing_recorded" | "out_of_scope" | "refused";

export type DepartmentAnswer = {
  kind: DepartmentAnswerKind;
  question: string;
  headline: string;
  /** Plain reading of the records, one line per figure. Never estimated. */
  statements: { label: string; value: number; detail: string; route: string; tone: string }[];
  /** Why NEØ could not answer, when it could not. */
  limitation: string | null;
  scope: { propertyLabel: string; today: string | null; modules: string[] };
};

/** Human names for the module keys `neo_my_work` returns. */
export const MODULE_LABEL: Record<string, string> = {
  pms: "Front office",
  housekeeping: "Housekeeping & maintenance",
  kitchen: "Kitchen",
  pos: "Restaurant & bar",
  delivery: "Delivery",
  inventory: "Stores & stock",
  procurement: "Procurement",
  finance: "Finance",
  events: "Events",
  workforce: "My approvals & people",
};

/** Question words that map onto a module. */
const MODULE_PATTERNS: { module: string; patterns: RegExp[] }[] = [
  { module: "pms", patterns: [/arrival/i, /check[- ]?in/i, /departure/i, /reservation/i, /booking/i, /front office/i, /guest arriv/i] },
  { module: "housekeeping", patterns: [/room/i, /clean/i, /housekeep/i, /dirty/i, /inspect/i, /work order/i, /maintenance/i, /fault/i] },
  { module: "kitchen", patterns: [/ticket/i, /kitchen/i, /prepar/i, /kds/i, /late order/i, /cook/i] },
  { module: "pos", patterns: [/\bpos\b/i, /bill/i, /open order/i, /restaurant/i, /\bbar\b/i, /settle/i, /table/i] },
  { module: "delivery", patterns: [/deliver/i, /rider/i, /dispatch/i] },
  { module: "inventory", patterns: [/stock/i, /reorder/i, /ingredient/i, /store/i, /item/i, /running out/i, /short/i, /count/i] },
  { module: "procurement", patterns: [/purchase/i, /requisition/i, /supplier/i, /\bpo\b/i, /order.*supplier/i] },
  { module: "finance", patterns: [/journal/i, /folio/i, /ledger/i, /posting/i, /cashbook/i] },
  { module: "events", patterns: [/event/i, /banquet/i, /function/i, /conferenc/i] },
  { module: "workforce", patterns: [/approval/i, /waiting for me/i, /my decision/i, /task/i, /leave/i] },
];

/** Questions NEØ must refuse outright, whatever the asker's modules. */
const REFUSALS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /salar|payroll|wage|what.*(paid|earn)s?\b|pay slip|payslip/i,
    reason: "Pay and payroll information is only available to the people with human-resources or payroll permission.",
  },
  {
    pattern: /other (property|hotel|branch)|another (property|hotel|branch)|all properties|every (property|branch)|compare (propert|branch)/i,
    reason:
      "NEØ answers for the property in your header only. Other properties are outside the scope your permissions and the property selector give you.",
  },
  {
    pattern: /ignore (my |your |the )?(permission|instruction|rule)|bypass|override (my |the )?(permission|access)|pretend you are|act as (an )?admin|system prompt/i,
    reason: "Your permissions decide what NEØ reads. They cannot be set aside by a question.",
  },
  {
    pattern: /revenue|profit|turnover|margin|bank balance|cash position|how much did we (make|earn|take)/i,
    reason: "Financial totals are only available to the people with finance or reporting permission.",
  },
];

export const DEPARTMENT_SUGGESTIONS: Record<string, string[]> = {
  pms: ["How many arrivals do I have today?", "Are any arrivals carrying a balance?"],
  housekeeping: ["How many rooms are not ready?", "What is assigned to me right now?"],
  kitchen: ["How many tickets are open?", "Are any tickets past their target time?"],
  pos: ["How many open orders are there?"],
  delivery: ["Which deliveries have no rider?", "Are any deliveries running late?"],
  inventory: ["What stock is at or below its reorder point?", "What still needs a stock count?"],
  procurement: ["Which purchase requests are waiting?", "Are any purchase orders overdue?"],
  finance: ["What journals are still unposted?"],
  events: ["What events are coming in the next seven days?"],
  workforce: ["What is waiting for my decision?"],
};

/** Suggestions for exactly the modules this person actually holds. */
export function suggestionsFor(items: WorkItem[]): string[] {
  const modules = Array.from(new Set(items.map((i) => i.module)));
  const out: string[] = [];
  for (const m of modules) for (const q of DEPARTMENT_SUGGESTIONS[m] ?? []) out.push(q);
  return out.slice(0, 6);
}

function matchModules(question: string): string[] {
  return MODULE_PATTERNS.filter((m) => m.patterns.some((p) => p.test(question))).map((m) => m.module);
}

/**
 * Payroll figures NEØ may quote, already released by the database.
 *
 * The database routine behind these numbers refuses anyone without payroll
 * permission, so their presence here *is* the authorisation. Nothing is
 * estimated: every figure is the recorded pay of the named period.
 */
export type PayrollFacts = {
  periodLabel: string;
  currency: string;
  employees: number;
  missingCompensation: number;
  base: number;
  deductions: number;
  net: number;
  route: string;
};

export const PAYROLL_PATTERN = /salar|payroll|wage|what.*(paid|earn)s?\b|pay slip|payslip/i;

/**
 * Bank and cash positions NEØ may quote.
 *
 * Every figure is the posted ledger position of an account this person's
 * finance permission already released; a bank account with no posting in the
 * period is reported as having none, never as zero money.
 */
export type BankFacts = {
  currency: string;
  rangeLabel: string;
  accounts: { name: string; balance: number | null }[];
  total: number;
  quiet: number;
  unmapped: number;
  route: string;
};

export const BANK_PATTERN =
  /bank|cash (position|balance|at bank)|balance (of|on|in) (the )?(bank|account)|how much (money |cash )?(do we|is) (have|there|held)|account balance/i;


/**
 * Answers strictly from the already-authorised work items. The caller supplies
 * nothing the database did not already release to this person.
 */
export function answerDepartmentQuestion(
  question: string,
  items: WorkItem[],
  scope: {
    propertyLabel: string;
    today?: string | null;
    payroll?: PayrollFacts | null;
    bank?: BankFacts | null;
  },

): DepartmentAnswer {
  const heldModules = Array.from(new Set(items.map((i) => i.module)));
  const base = {
    question,
    scope: { propertyLabel: scope.propertyLabel, today: scope.today ?? null, modules: heldModules },
  };

  // Cross-property and permission-bypass questions are refused before any pay
  // figure is considered, whoever is asking.
  const hardRefusal = REFUSALS.slice(1, 3).find((r) => r.pattern.test(question));

  // Pay questions are answered only when the database itself released the
  // period's figures to this person; otherwise the refusal below stands.
  if (PAYROLL_PATTERN.test(question) && scope.payroll && !hardRefusal) {

    const p = scope.payroll;
    const money = (n: number) => `${p.currency} ${Math.round(n).toLocaleString()}`;
    return {
      ...base,
      kind: "answered",
      headline: `${p.periodLabel}: ${money(p.net)} net pay across ${p.employees} employee${p.employees === 1 ? "" : "s"}.`,
      statements: [
        { label: "Net pay", value: Math.round(p.net), detail: `${money(p.net)} · ${p.periodLabel}`, route: p.route, tone: "info" },
        { label: "Contracted base pay", value: Math.round(p.base), detail: money(p.base), route: p.route, tone: "ok" },
        { label: "Deductions recorded", value: Math.round(p.deductions), detail: money(p.deductions), route: p.route, tone: "warning" },
        { label: "Employees in the period", value: p.employees, detail: "From the recorded payroll inputs", route: p.route, tone: "ok" },
      ],
      limitation:
        p.missingCompensation > 0
          ? `${p.missingCompensation} employee${p.missingCompensation === 1 ? " has" : "s have"} no pay record yet, so they are counted at zero rather than estimated.`
          : null,
    };
  }

  // Bank and cash positions are answered only when the database released the
  // posted ledger to this person; otherwise the money refusal below stands.
  if (BANK_PATTERN.test(question) && scope.bank && !hardRefusal) {
    const b = scope.bank;
    const money = (n: number) => `${b.currency} ${Math.round(n).toLocaleString()}`;
    const named = b.accounts.filter((a) => a.balance !== null);
    return {
      ...base,
      kind: named.length > 0 ? "answered" : "nothing_recorded",
      headline:
        named.length > 0
          ? `${money(b.total)} posted across ${named.length} account${named.length === 1 ? "" : "s"} · ${b.rangeLabel}.`
          : `No posting reached a bank account in ${b.rangeLabel}.`,
      statements: named.slice(0, 6).map((a) => ({
        label: a.name,
        value: Math.round(a.balance ?? 0),
        detail: `${money(a.balance ?? 0)} · posted position`,
        route: b.route,
        tone: (a.balance ?? 0) < 0 ? "warning" : "ok",
      })),
      limitation:
        b.quiet > 0 || b.unmapped > 0
          ? [
              b.quiet > 0
                ? `${b.quiet} account${b.quiet === 1 ? " has" : "s have"} no posting in this period, so no balance is shown for ${b.quiet === 1 ? "it" : "them"} rather than a zero.`
                : null,
              b.unmapped > 0
                ? `${b.unmapped} account${b.unmapped === 1 ? " is" : "s are"} not mapped to a ledger account, so ${b.unmapped === 1 ? "it has" : "they have"} no balance to read.`
                : null,
            ]
              .filter(Boolean)
              .join(" ")
          : null,
    };
  }

  const refusal = hardRefusal ?? REFUSALS.find((r) => r.pattern.test(question));

  if (refusal) {
    // Cross-property and permission-bypass questions are always refused. Money
    // wording never rescues them, whatever modules the asker holds.
    const financeAllowed = !hardRefusal && heldModules.includes("finance");
    if (!financeAllowed || !/revenue|profit|turnover|margin|bank balance|cash position|how much did we/i.test(question)) {
      return {
        ...base,
        kind: "refused",
        headline: "NEØ cannot answer that with your permissions.",
        statements: [],
        limitation: refusal.reason,
      };
    }
  }



  const wanted = matchModules(question);
  const available = wanted.filter((m) => heldModules.includes(m));

  if (wanted.length > 0 && available.length === 0) {
    return {
      ...base,
      kind: "out_of_scope",
      headline: "That is outside the areas your permissions reach.",
      statements: [],
      limitation: `Your access covers ${
        heldModules.length ? heldModules.map((m) => MODULE_LABEL[m] ?? m).join(", ") : "no operational area yet"
      }. Ask an administrator if you need more.`,
    };
  }

  const scoped = available.length > 0 ? items.filter((i) => available.includes(i.module)) : items;

  if (scoped.length === 0) {
    return {
      ...base,
      kind: "out_of_scope",
      headline: "Your permissions do not yet reach any operational area.",
      statements: [],
      limitation: "Ask an administrator to grant the access your work needs.",
    };
  }

  const ranked = [...scoped].sort((a, b) => Number(b.value) - Number(a.value));
  const attention = ranked.filter((i) => i.tone !== "ok" && Number(i.value) > 0);
  const shown = (attention.length > 0 ? attention : ranked).slice(0, 6);
  // Nothing in the question mapped onto an area NEØ holds figures for. Rather
  // than guessing at a meaning, it says so and shows the person's own position.
  const unmatched = wanted.length === 0;
  const headline = unmatched
    ? "NEØ could not match that question to a figure it holds, so here is where your work stands."
    : attention.length > 0
      ? `${attention.length} thing${attention.length === 1 ? "" : "s"} in your area need${attention.length === 1 ? "s" : ""} attention.`
      : "Nothing in the records you can see needs attention right now.";

  return {
    ...base,
    kind: attention.length > 0 ? "answered" : "nothing_recorded",
    headline,
    statements: shown.map((i) => ({
      label: i.label,
      value: Number(i.value),
      detail: i.detail,
      route: i.route,
      tone: i.tone,
    })),
    limitation: unmatched
      ? `Try naming what you need — ${
          heldModules.length ? heldModules.map((m) => MODULE_LABEL[m] ?? m).join(", ") : "your area"
        } — for example “how many rooms are not ready?”.`
      : null,
  };

}
