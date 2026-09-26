/**
 * Role-specific intelligence: the same engine, reduced to what the signed-in
 * person's effective permissions already allow them to open.
 */
import { describe, expect, it } from "vitest";
import {
  lensFor,
  MODULE_HOME,
  permittedModules,
  scopeChanges,
  scopeDecisions,
  scopeDiscoveries,
} from "@/lib/intelligence-role";
import { buildOutliers } from "@/lib/intelligence-engine";
import type { ChangeItem, Decision, Discovery } from "@/lib/intelligence-types";

const viewerFor = (paths: string[], canSeeMoney = false) => ({
  canSeePage: (p: string) => paths.some((allowed) => p.startsWith(allowed)),
  canSeeMoney,
});

const discovery = (over: Partial<Discovery>): Discovery => ({
  id: "d",
  title: "t",
  conclusion: "c",
  severity: "warning",
  score: 10,
  magnitude: 3,
  impact: { value: 1000, currency: "KES" },
  impactNote: "Value taken directly from recorded balances.",
  modules: ["finance"],
  evidence: [{ label: "e", source: "s", module: "finance", drillTo: "/finance/posting" }],
  actionable: true,
  drillTo: "/finance/posting",
  ...over,
});

describe("role lens", () => {
  it("resolves the lens from capabilities, never from a role name", () => {
    const manager = viewerFor([MODULE_HOME.finance, MODULE_HOME.pms, MODULE_HOME.pos], true);
    expect(lensFor(manager).label).toBe("Management view");

    const accountant = viewerFor([MODULE_HOME.finance], true);
    expect(lensFor(accountant).label).toBe("Finance view");

    const waiter = viewerFor([MODULE_HOME.pos]);
    expect(lensFor(waiter).label).toBe("Service view");

    expect(lensFor(viewerFor([])).label).toBe("Personal view");
  });

  it("lists only the modules the viewer can open", () => {
    expect(permittedModules(viewerFor([MODULE_HOME.kitchen]))).toEqual(["kitchen"]);
  });
});

describe("scoping findings to the viewer", () => {
  it("hides a finding whose modules are all out of reach", () => {
    const waiter = viewerFor([MODULE_HOME.pos]);
    expect(scopeDiscoveries([discovery({})], waiter)).toEqual([]);
  });

  it("keeps the finding but withholds money without financial access", () => {
    const clerk = viewerFor([MODULE_HOME.finance], false);
    const [out] = scopeDiscoveries([discovery({})], clerk);
    expect(out?.impact).toBeNull();
    expect(out?.impactNote).toMatch(/withheld/i);
  });

  it("keeps evidence lines but drops links the viewer cannot follow", () => {
    const viewer = viewerFor([MODULE_HOME.pms]);
    const d = discovery({
      modules: ["pms"],
      drillTo: "/pms/reservations",
      evidence: [{ label: "e", source: "s", module: "finance", drillTo: "/finance/posting" }],
    });
    const [out] = scopeDiscoveries([d], viewer);
    expect(out?.evidence).toHaveLength(1);
    expect(out?.evidence[0]?.drillTo).toBeUndefined();
  });

  it("hides a decision whose action route is not permitted", () => {
    const decision: Decision = {
      id: "x",
      headline: "h",
      kind: "recommendation",
      why: "w",
      evidence: [],
      confidence: "high",
      confidenceNote: "n",
      impact: "i",
      alternatives: [],
      action: { label: "Open", to: "/finance/posting", requiresAuthorisation: true },
    };
    expect(scopeDecisions([decision], viewerFor([MODULE_HOME.pos]))).toEqual([]);
    expect(scopeDecisions([decision], viewerFor([MODULE_HOME.finance]))).toHaveLength(1);
  });

  it("hides money changes from a viewer without financial access", () => {
    const change: ChangeItem = {
      id: "c",
      label: "Revenue",
      current: 10,
      previous: 5,
      delta: 5,
      deltaPercent: 100,
      direction: "up",
      material: true,
      favourable: "good",
      unit: "money",
      modules: ["finance"],
      evidence: [],
    };
    expect(scopeChanges([change], viewerFor([MODULE_HOME.finance], false))).toEqual([]);
    expect(scopeChanges([change], viewerFor([MODULE_HOME.finance], true))).toHaveLength(1);
  });
});

describe("proactive outlier discoveries", () => {
  const history = (values: number[]) =>
    values.map((v, i) => ({ day: `2026-03-${String(i + 1).padStart(2, "0")}`, occupancy: v }));

  it("says nothing without enough recorded days", () => {
    expect(buildOutliers({ authorised: true, demand: { history: history([50, 52, 48]) } } as never)).toEqual([]);
  });

  it("says nothing when the period is flat", () => {
    const flat = history(Array.from({ length: 14 }, () => 60));
    expect(buildOutliers({ authorised: true, demand: { history: flat } } as never)).toEqual([]);
  });

  it("flags a genuine two-sigma day with confidence and evidence", () => {
    const values = [...Array.from({ length: 15 }, (_, i) => 60 + (i % 3)), 10];
    const out = buildOutliers({ authorised: true, demand: { history: history(values) } } as never);
    expect(out.length).toBeGreaterThan(0);
    const first = out[0]!;
    expect(first.outlier).toBe(true);
    expect(first.confidence).toBe("high");
    expect(first.impact).toBeNull();
    expect(first.evidence[0]?.drillTo).toBe("/pms/availability");
    expect(first.conclusion).toMatch(/standard deviations/);
  });
});
