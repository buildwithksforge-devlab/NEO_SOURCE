import { describe, expect, it } from "vitest";
import {
  buildBrief,
  buildChanges,
  buildDecisions,
  buildDiscoveries,
  buildInvestigation,
  priorPeriod,
  simulateOccupancy,
} from "@/lib/intelligence-engine";
import type { IntelligencePayload } from "@/lib/intelligence-data";

const payload = (over: Partial<IntelligencePayload> = {}): IntelligencePayload => ({
  authorised: true,
  currency: "KES",
  money_visible: true,
  generated_at: "2026-08-28T06:00:00Z",
  period: { from: "2026-08-01", to: "2026-08-28", days: 28 },
  briefing: {
    occupancy_rate: 61,
    sellable_rooms: 100,
    unavailable_rooms: 7,
    unmatched_eligible: 12,
    failed_postings: 2,
    overdue_tasks: 4,
    pending_approvals: 3,
    failed_workflows: 0,
    pos_open_value: 45_000,
    receivables: 120_000,
    net_recognised_revenue: 3_000_000,
  },
  demand: {
    history: [{ day: "2026-08-01", occupancy: 60 }],
    forward: [{ day: "2026-08-29", on_the_books: 10, sellable: 100 }],
    sample_days: 28,
    average_occupancy: 61,
    sufficient: true,
    method: "test",
    confidence: "moderate",
  },
  menu: { items_total: 40, items_costed: 25, coverage_percent: 62.5, items: [], note: "" },
  ...over,
});

describe("intelligence discoveries", () => {
  it("detects only what the records support and never invents a finding", () => {
    const empty = buildDiscoveries({ authorised: true, briefing: {} });
    expect(empty).toEqual([]);
  });

  it("ranks critical, material and actionable findings first", () => {
    const found = buildDiscoveries(payload());
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.severity).toBe("critical");
    for (let i = 1; i < found.length; i += 1) {
      expect(found[i - 1]!.score).toBeGreaterThanOrEqual(found[i]!.score);
    }
  });

  it("attaches evidence with a record count and a route into the module", () => {
    const unposted = buildDiscoveries(payload()).find((d) => d.id === "finance-unposted");
    expect(unposted?.evidence[0]?.recordCount).toBe(12);
    expect(unposted?.evidence[0]?.drillTo).toBe("/finance/posting");
  });

  it("refuses to quantify impact when no recorded value can be attributed", () => {
    const overdue = buildDiscoveries(payload()).find((d) => d.id === "tasks-overdue");
    expect(overdue?.impact).toBeNull();
    expect(overdue?.impactNote).toMatch(/not quantified/i);
  });

  it("returns nothing when the payload is unauthorised", () => {
    expect(buildDiscoveries({ authorised: false })).toEqual([]);
  });
});

describe("what changed", () => {
  it("computes the immediately preceding window of equal length", () => {
    expect(priorPeriod("2026-08-01", "2026-08-28")).toEqual({ from: "2026-07-04", to: "2026-07-31" });
  });

  it("marks only material movements and labels their direction", () => {
    const prior = payload({ briefing: { ...payload().briefing, occupancy_rate: 60, unavailable_rooms: 2 } });
    const changes = buildChanges(payload(), prior);
    const occ = changes.find((c) => c.id === "occupancy");
    const rooms = changes.find((c) => c.id === "unavailable");
    expect(occ?.material).toBe(false); // 1 point move is noise
    expect(rooms?.material).toBe(true);
    expect(rooms?.direction).toBe("up");
    expect(rooms?.favourable).toBe("bad");
  });

  it("hides monetary comparisons from users without finance visibility", () => {
    const restricted = payload({ money_visible: false });
    const changes = buildChanges(restricted, restricted);
    expect(changes.some((c) => c.unit === "money")).toBe(false);
  });

  it("returns nothing without a prior payload rather than guessing", () => {
    expect(buildChanges(payload(), undefined)).toEqual([]);
  });
});

describe("morning brief", () => {
  it("shows at most four items, most material first", () => {
    const items = buildBrief(buildDiscoveries(payload()), []);
    expect(items.length).toBeLessThanOrEqual(4);
    expect(items[0]?.severity).toBe("critical");
  });

  it("is empty when nothing was detected", () => {
    expect(buildBrief([], [])).toEqual([]);
  });
});

describe("decisions", () => {
  it("never offers an action that NEØ performs itself", () => {
    for (const d of buildDecisions(payload())) {
      expect(d.action?.requiresAuthorisation ?? true).toBe(true);
      expect(d.alternatives.length).toBeGreaterThan(0);
      expect(d.evidence.length).toBeGreaterThan(0);
    }
  });

  it("explains its confidence from recorded history", () => {
    const decisions = buildDecisions(payload());
    expect(decisions.every((d) => d.confidenceNote.length > 0)).toBe(true);
  });
});

describe("investigations", () => {
  it("breaks an issue into groups and states what it cannot explain", () => {
    const inv = buildInvestigation("rooms-unavailable", payload(), {
      propertyLabel: "Nairobi",
      from: "2026-08-01",
      to: "2026-08-28",
    });
    expect(inv?.groups[0]?.value).toBe(7);
    expect(inv?.drivers.some((d) => d.kind === "limitation")).toBe(true);
  });

  it("returns null for an unknown topic instead of inventing one", () => {
    expect(buildInvestigation("not-a-topic", payload(), { propertyLabel: "x", from: "a", to: "b" })).toBeNull();
  });
});

describe("scenarios", () => {
  it("is arithmetic only and yields nothing without recorded inputs", () => {
    expect(simulateOccupancy(100, 80, 10_000)).toMatchObject({ rooms: 80, value: 800_000 });
    expect(simulateOccupancy(null, 80, 10_000).rooms).toBeNull();
    expect(simulateOccupancy(100, 80, null).value).toBeNull();
  });
});
