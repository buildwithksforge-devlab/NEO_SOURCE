import { describe, expect, it } from "vitest";
import {
  OPERATIONS_CARDS,
  OPERATIONS_PANELS,
  operationsCard,
  type OperationsCard,
} from "@/lib/data-sources";
import { ROUTE_CAPABILITIES, UNIVERSAL_ROUTES, capabilityForPath, capabilityKey } from "@/lib/capabilities";
import { dashboardSpec } from "@/lib/dashboards";
import { resolveCardState } from "@/lib/card-state";

const spec = dashboardSpec("operations");
const all: OperationsCard[] = [...OPERATIONS_CARDS, ...OPERATIONS_PANELS];
const prefixes = new Set(ROUTE_CAPABILITIES.map((e) => e.prefix));

describe("operations dashboard card inventory", () => {
  it("inventories every live widget the Operations dashboard renders", () => {
    for (const w of spec.widgets) {
      if (w.source !== "live") continue;
      expect(operationsCard(w.id), `${w.id} is rendered but not inventoried`).toBeTruthy();
    }
  });

  it("keeps each card's metric path aligned with the rendered widget", () => {
    for (const w of spec.widgets) {
      if (w.kind !== "kpi" || w.source !== "live") continue;
      const card = operationsCard(w.id)!;
      expect(card.metric, `${w.id} metric drifted from the widget`).toBe(w.metric);
    }
  });

  it("records a full data contract for every card", () => {
    for (const card of all) {
      expect(card.service, `${card.key} has no authoritative service`).toBeTruthy();
      expect(card.sourceTables.length, `${card.key} names no source table`).toBeGreaterThan(0);
      expect(card.filters).toBeTruthy();
      expect(card.dateRange).toBeTruthy();
      expect(card.calculation).toBeTruthy();
      expect(card.refresh).toBeTruthy();
    }
  });

  it("never reads a dashboard-only table as competing truth", () => {
    for (const card of all) {
      for (const table of card.sourceTables) {
        expect(
          /^dashboard_(snapshot|metric|card|kpi_cache)/.test(table),
          `${card.key} reads a parallel dashboard table (${table})`,
        ).toBe(false);
      }
    }
  });

  it("drills into a route the app actually serves", () => {
    for (const card of all) {
      expect(
        prefixes.has(card.drillTo) || UNIVERSAL_ROUTES.has(card.drillTo),
        `${card.key} drills to unknown ${card.drillTo}`,
      ).toBe(true);
    }
  });

  it("states a permission that matches its drill-through route", () => {
    for (const card of all) {
      if (card.capability === "universal") {
        expect(
          UNIVERSAL_ROUTES.has(card.drillTo),
          `${card.key} claims universal access but drills into a guarded route`,
        ).toBe(true);
        continue;
      }
      const cap = capabilityForPath(card.drillTo);
      expect(cap, `${card.key} drill-through is unguarded`).not.toBeNull();
      expect(capabilityKey(cap!)).toBe(card.capability);
    }
  });

  it("uses unique card keys", () => {
    const keys = all.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("seven-state card resolution", () => {
  it("never shows a value while loading", () => {
    expect(resolveCardState({ isLoading: true, value: 0 })).toBe("loading");
    expect(resolveCardState({ hasLoaded: false, value: 12 })).toBe("loading");
  });

  it("renders a real zero once loaded", () => {
    expect(resolveCardState({ isLoading: false, hasLoaded: true, value: 0 })).toBe("ready");
  });

  it("separates no records from not configured", () => {
    expect(resolveCardState({ hasLoaded: true, value: null })).toBe("no-records");
    expect(resolveCardState({ hasLoaded: true, configured: false, value: null })).toBe("not-configured");
  });

  it("treats refusals as access denied and other faults as query failures", () => {
    expect(resolveCardState({ permitted: false, value: 4 })).toBe("access-denied");
    expect(resolveCardState({ error: { code: "42501" } })).toBe("access-denied");
    expect(resolveCardState({ error: { message: "permission denied for table tasks" } })).toBe("access-denied");
    expect(resolveCardState({ error: new Error("network") })).toBe("query-failed");
    expect(resolveCardState({ hasLoaded: true, value: Number.NaN })).toBe("query-failed");
  });

  it("puts unbuilt modules ahead of every other state", () => {
    expect(resolveCardState({ implemented: false, permitted: false, error: new Error("x") })).toBe(
      "not-implemented",
    );
  });
});
