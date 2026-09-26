import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_BY_SOURCE,
  LIFECYCLE_RULES,
  eligibility,
  idempotencyKey,
  journalBalances,
  reversalKey,
} from "@/lib/finance-lifecycle";
import { FACTS } from "@/lib/facts";
import { SHARED_FACT_PATHS } from "@/components/common/FactSection";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Deployed definitions of neo_finance_post_txn, neo_finance_eligible_sources,
 *  neo_gl_post and neo_finance_reverse_posting, exported from the live database. */
const SQL = read("src/lib/__tests__/fixtures/finance-posting.sql");

const eligibleBlock = (source: string) => {
  const start = SQL.indexOf(`'${source}'`, SQL.indexOf("neo_finance_eligible_sources"));
  const end = SQL.indexOf("UNION ALL", start);
  return SQL.slice(start, end === -1 ? start + 900 : end);
};

describe("posting lifecycle eligibility", () => {
  it("covers every source type the database dispatcher accepts", () => {
    const declared = LIFECYCLE_RULES.map((r) => r.source).sort();
    const inSql = [
      ...new Set(
        [...SQL.matchAll(/_source_type = '([a-z_]+)'/g)].map((m) => m[1] as string),
      ),
    ].sort();
    expect(inSql.length).toBeGreaterThan(0);
    expect(declared).toEqual(inSql);
  });

  it("declares the same eligible operational states as the database", () => {
    for (const rule of LIFECYCLE_RULES) {
      if (rule.source === "event_deposit") continue; // amount-driven, not status-driven
      const block = eligibleBlock(rule.source);
      for (const status of rule.eligible) expect(block, `${rule.source}/${status}`).toContain(`'${status}'`);
    }
  });

  it("never treats draft, open, forecast or request states as accounting value", () => {
    for (const rule of LIFECYCLE_RULES) {
      for (const bad of rule.ineligible) {
        expect(rule.eligible, `${rule.source}/${bad}`).not.toContain(bad);
        expect(eligibility(rule.source, bad).eligible).toBe(false);
        expect(eligibility(rule.source, bad).reason).toBe("ineligible_lifecycle");
      }
    }
    expect(eligibility("pos_order", "draft").eligible).toBe(false);
    expect(eligibility("pos_order", "served").eligible).toBe(false);
    expect(eligibility("event_earned", "confirmed").eligible).toBe(false);
    expect(eligibility("event_invoice", "draft").eligible).toBe(false);
    expect(eligibility("supplier_invoice", "pending_approval").eligible).toBe(false);
  });

  it("posts POS settlements, folio charges, collections, events, delivery, laundry and payables", () => {
    for (const [source, status] of [
      ["pos_order", "closed"],
      ["folio_charge", "posted"],
      ["folio_payment", "confirmed"],
      ["event_deposit", "confirmed"],
      ["event_invoice", "issued"],
      ["event_earned", "completed"],
      ["event_cancellation", "cancelled"],
      ["delivery_order", "delivered"],
      ["laundry_order", "delivered"],
      ["supplier_invoice", "approved"],
      ["supplier_payment", "paid"],
    ] as const) {
      expect(eligibility(source, status).eligible, `${source}/${status}`).toBe(true);
    }
  });

  it("rejects zero-value and unknown sources instead of posting an empty journal", () => {
    expect(eligibility("pos_order", "closed", 0).reason).toBe("zero_amount");
    expect(eligibility("mystery_module", "closed").reason).toBe("unknown_source_type");
    expect(SQL).toContain("unknown_source_type");
    expect(SQL).toContain("nothing_to_post");
  });

  it("keeps POS routed to a folio out of double revenue recognition", () => {
    expect(LIFECYCLE_BY_SOURCE["pos_order"]!.exclusion).toContain("folio");
    expect(SQL).toContain("revenue is recognised on the folio charge");
  });

  it("recognises a partially paid event as deposit applied plus receivable remainder", () => {
    const total = 100_000;
    const deposit = 30_000;
    const lines = [
      { code: "2030", debit: deposit },
      { code: "1060", debit: total - deposit },
      { code: "4060", credit: total },
    ];
    expect(journalBalances(lines)).toBe(true);
    expect(SQL).toContain("Deposit applied");
    expect(SQL).toContain("Event receivable");
  });
});

describe("idempotency, reversal and balance guarantees", () => {
  it("builds one stable idempotency key per source and posting type", () => {
    expect(idempotencyKey("pos_order", "abc", "revenue")).toBe("pos_order:abc:revenue");
    expect(SQL).toContain("_source_type || ':' || _source_id::text || ':' || posting");
  });

  it("returns the existing journal on replay instead of posting twice", () => {
    expect(SQL).toContain("duplicate_prevented");
    expect(SQL).toMatch(/idempotency_key = key/);
  });

  it("links a reversal to the original journal and mirrors its lines", () => {
    expect(reversalKey("event_earned", "abc", "earned")).toBe("event_earned:abc:earned:reversal");
    expect(SQL).toContain("reversed_by_journal_id");
    expect(SQL).toContain("no_original_posting");
    expect(SQL).toContain("already_reversed");
    // Reversal swaps debit and credit, so the pair nets to zero.
    const original = [{ code: "1060", debit: 5000 }, { code: "4060", credit: 5000 }];
    const reversal = [{ code: "1060", credit: 5000 }, { code: "4060", debit: 5000 }];
    expect(journalBalances(original)).toBe(true);
    expect(journalBalances(reversal)).toBe(true);
    expect(journalBalances([...original, ...reversal])).toBe(true);
  });

  it("refuses an unbalanced journal", () => {
    expect(journalBalances([{ code: "1010", debit: 100 }, { code: "4010", credit: 90 }])).toBe(false);
    expect(journalBalances([])).toBe(false);
    expect(SQL).toContain("journal is not balanced");
  });

  it("scopes every posting to the caller's organisation, property, timezone and currency", () => {
    expect(SQL).toContain("public.current_org_id()");
    expect(SQL).toContain("organization_id = org");
    expect(SQL).toContain("neo_fact_timezone");
    expect(SQL).toContain("neo_fact_currency");
  });

  it("denies posting without a finance capability and serialises concurrent replays", () => {
    expect(SQL).toContain("insufficient_privilege");
    expect(SQL).toContain("has_permission('finance','edit')");
    expect(SQL).toContain("pg_advisory_xact_lock");
  });

  it("records audit evidence and a domain event for every posting", () => {
    expect(SQL).toContain("neo_record_posting_receipt");
    expect(SQL).toContain("finance.posted");
  });

  it("exposes only the client-callable posting routines, to authenticated callers", () => {
    for (const fn of ["neo_finance_post_family", "neo_finance_backfill"]) {
      expect(RPC_MANIFEST[fn], fn).toBe("authenticated");
    }
    // Internal dispatcher and reversal writer are reached through triggers and
    // the dispatcher only — they are never callable from the browser.
    for (const fn of [
      "neo_finance_post_txn",
      "neo_finance_reverse_posting",
      "neo_finance_eligible_sources",
    ]) {
      expect(RPC_MANIFEST[fn], fn).toBeUndefined();
    }
  });

});

describe("shared scope equality across dashboard, analytics and finance", () => {
  const frame = read("src/components/dashboard/DashboardFrame.tsx");
  const analytics = read("src/routes/_shell.analytics.index.tsx");
  const finance = read("src/routes/_shell.finance.index.tsx");

  it("publishes open value, recognised revenue, collections, receivables, payables and room nights as one shared list", () => {
    for (const p of [
      "accounting.net_recognised_revenue",
      "operational.pos_open_value",
      "collections.total",
      "receivables.total",
      "payables.total",
      "rooms.occupancy_rate",
      "rooms.occupied_room_nights",
      "rooms.available_room_nights",
    ]) {
      expect(SHARED_FACT_PATHS, p).toContain(p);
      expect(FACTS[p], p).toBeDefined();
    }
  });

  it("renders that same list from the same hook on all three surfaces", () => {
    for (const src of [analytics, finance]) {
      expect(src).toContain("SHARED_FACT_PATHS");
      expect(src).toContain("FactSection");
      expect(src).toContain("ReconciliationStatusPanel");
    }
    expect(frame).toContain("useFacts");
    expect(frame).toContain("ReconciliationStatusPanel");
  });

  it("uses one query key so the three surfaces cannot disagree for the same period", () => {
    const facts = read("src/lib/facts.ts");
    expect(facts).toContain('"neo-facts"');
    expect(facts).toContain("scope.branchId");
    expect(facts).toContain("scope.from");
    expect(facts).toContain("scope.to");
  });
});

describe("loading, error and empty states never read as a false zero", () => {
  const card = read("src/components/common/FactCard.tsx");
  const section = read("src/components/common/FactSection.tsx");
  const posting = read("src/routes/_shell.finance.posting.tsx");
  const analytics = read("src/routes/_shell.analytics.index.tsx");

  it("shows a skeleton while loading and a failure message on error, never 0", () => {
    expect(card).toContain("if (isLoading) return <Skeleton");
    expect(card).toContain("Could not be calculated");
    expect(card.indexOf("if (isLoading)")).toBeLessThan(card.indexOf("formatFact(value"));
  });

  it("prints an em dash rather than zero when a value is unknown", async () => {
    const { formatFact } = await import("@/lib/facts");
    expect(formatFact(null, "money", "KES")).toBe("—");
    expect(formatFact(null, "count")).toBe("—");
    expect(formatFact(0, "money", "KES")).toBe("KES 0");
  });

  it("explains a genuine zero with its eligibility rule instead of leaving it bare", () => {
    expect(card).toContain("const zero =");
    expect(card).toContain("fact.eligibility");
  });

  it("blocks unauthorised figures rather than rendering them as zero", () => {
    expect(card).toContain("Not authorised");
    expect(section).toContain("factsMonetaryAuthorised");
  });

  it("keeps analytics and finance posting on loading and error branches", () => {
    expect(analytics).toContain("kpis.isLoading");
    expect(analytics).toContain("kpis.isError");
    expect(posting).toMatch(/isLoading|Skeleton/);
  });
});
