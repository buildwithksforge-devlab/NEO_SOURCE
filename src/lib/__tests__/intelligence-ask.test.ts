import { describe, expect, it } from "vitest";
import { answerQuestion, classifyQuestion, followUpsFor } from "@/lib/intelligence-ask";
import type { IntelligencePayload } from "@/lib/intelligence-data";
import type { Scope } from "@/lib/intelligence-types";

const scope: Scope = { propertyLabel: "Nairobi", from: "2026-08-01", to: "2026-08-28" };

const payload: IntelligencePayload = {
  authorised: true,
  currency: "KES",
  money_visible: true,
  period: { from: "2026-08-01", to: "2026-08-28", days: 28 },
  briefing: {
    occupancy_rate: 61,
    sellable_rooms: 100,
    unavailable_rooms: 7,
    net_recognised_revenue: 3_000_000,
    pos_finalised_sales: 800_000,
    pos_open_value: 45_000,
    collected: 2_500_000,
    receivables: 120_000,
    unmatched_eligible: 12,
    failed_postings: 2,
    overdue_tasks: 4,
    pending_approvals: 3,
    failed_workflows: 0,
  },
  demand: {
    history: [{ day: "2026-08-01", occupancy: 60 }],
    forward: [{ day: "2026-08-29", on_the_books: 10, sellable: 100 }],
    sample_days: 28,
    average_occupancy: 61,
    sufficient: true,
    method: "recorded occupancy",
    confidence: "moderate",
  },
  sentiment: { responses: 0, average_rating: null, detractors: 0, method: "rating_derived", note: "", themes: [] },
  menu: { items_total: 40, items_costed: 25, coverage_percent: 62.5, items: [], note: "" },
};

describe("question classification", () => {
  it("routes questions to grounded topics", () => {
    expect(classifyQuestion("How much revenue did we make?")).toBe("revenue");
    expect(classifyQuestion("Why are rooms not sellable?")).toBe("rooms");
    expect(classifyQuestion("What changed since last week?")).toBe("changes");
    expect(classifyQuestion("Tell me a joke")).toBe("unknown");
  });
});

describe("grounded answers", () => {
  it("answers from the payload and cites evidence with a route", () => {
    const a = answerQuestion("What is our occupancy?", { payload, scope });
    expect(a.headline).toContain("61%");
    expect(a.evidence[0]?.drillTo).toBe("/pms/availability");
    expect(a.limitation).toBeNull();
  });

  it("withholds monetary values when finance visibility is absent", () => {
    const a = answerQuestion("What is our revenue?", {
      payload: { ...payload, money_visible: false },
      scope,
    });
    expect(a.limitation).toMatch(/Finance visibility/i);
    expect(JSON.stringify(a)).not.toContain("3000000");
  });

  it("refuses an unauthorised scope instead of answering", () => {
    const a = answerQuestion("What is our revenue?", {
      payload: { authorised: false, reason: "insufficient_capability" },
      scope,
    });
    expect(a.confidence).toBe("insufficient");
    expect(a.limitation).toMatch(/withheld/i);
  });

  it("states honestly when no feedback records exist", () => {
    const a = answerQuestion("What did guests say?", { payload, scope });
    expect(a.limitation).toMatch(/No feedback records/i);
    expect(a.headline).toMatch(/No guest feedback/i);
  });

  it("labels booking pace as recorded demand, never a forecast", () => {
    const a = answerQuestion("How is our pace for the next 14 days?", { payload, scope });
    expect(a.statements.some((s) => s.kind === "limitation" && /not a statistical forecast/i.test(s.text))).toBe(true);
  });

  it("declines questions outside the grounded record set", () => {
    const a = answerQuestion("Who should I promote next quarter?", { payload, scope });
    expect(a.topic).toBe("unknown");
    expect(a.limitation).toMatch(/outside the grounded record set/i);
    expect(a.evidence).toEqual([]);
  });

  it("needs a prior payload before it will compare periods", () => {
    const a = answerQuestion("What changed?", { payload, scope });
    expect(a.limitation).toMatch(/prior-period/i);
  });

  it("always reports the scope it answered within", () => {
    const a = answerQuestion("What is our occupancy?", { payload, scope });
    expect(a.scope).toEqual(scope);
  });
});

describe("contextual continuation and driver attribution", () => {
  it("offers follow-up questions for every known topic", () => {
    expect(followUpsFor("revenue").length).toBeGreaterThan(0);
    expect(followUpsFor("occupancy").length).toBeGreaterThan(0);
    expect(followUpsFor("not-a-topic").length).toBeGreaterThan(0);
  });
});
