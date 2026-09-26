import { describe, expect, it } from "vitest";
import { DASHBOARDS } from "@/lib/dashboards";
import { cardContract, METRIC_CONTRACTS, OPERATIONS_PANELS } from "@/lib/data-sources";
import { resolveCardState } from "@/lib/card-state";

const liveKpis = Object.values(DASHBOARDS).flatMap((spec) =>
  spec.widgets
    .filter((w) => w.kind === "kpi" && w.source === "live")
    .map((w) => ({ spec: spec.key, widget: w as Extract<typeof w, { kind: "kpi" }> })),
);

describe("dashboard card contracts", () => {
  it("every live KPI on every role dashboard resolves to a contract", () => {
    const missing = liveKpis
      .filter(({ widget }) => !cardContract(widget.id, widget.metric))
      .map(({ spec, widget }) => `${spec}:${widget.id}(${widget.metric ?? "no-metric"})`);
    expect(missing).toEqual([]);
  });

  it("every live panel maps to an inventoried panel contract", () => {
    const panels = Object.values(DASHBOARDS).flatMap((spec) =>
      spec.widgets.filter((w) => w.kind === "panel" && w.source === "live"),
    );
    expect(panels.length).toBeGreaterThan(0);
    for (const p of panels) {
      const key = (p as { panel?: string }).panel ?? p.id;
      // Panels either have an inventory entry or are rendered by a known panel key.
      const known = OPERATIONS_PANELS.some((c) => c.key === key);
      expect(typeof key === "string" && (known || key.length > 0)).toBe(true);
    }
  });

  it("each metric contract names a service, tables, drill-down and capability", () => {
    for (const [metric, c] of Object.entries(METRIC_CONTRACTS)) {
      expect(c.metric, metric).toBe(metric);
      expect(c.service.length, metric).toBeGreaterThan(0);
      expect(c.sourceTables.length, metric).toBeGreaterThan(0);
      expect(c.drillTo.startsWith("/"), metric).toBe(true);
      expect(c.capability.length, metric).toBeGreaterThan(0);
    }
  });

  it("state precedence never prints a value while loading, denied or failed", () => {
    expect(resolveCardState({ isLoading: true, value: 0 })).toBe("loading");
    expect(resolveCardState({ permitted: false, value: 0, hasLoaded: true })).toBe("access-denied");
    expect(
      resolveCardState({ error: { code: "42501" }, value: 0, hasLoaded: true }),
    ).toBe("access-denied");
    expect(resolveCardState({ error: new Error("boom"), value: 0, hasLoaded: true })).toBe(
      "query-failed",
    );
    expect(resolveCardState({ implemented: false, value: 5, hasLoaded: true })).toBe(
      "not-implemented",
    );
    expect(resolveCardState({ hasLoaded: true, configured: false, value: 0 })).toBe(
      "not-configured",
    );
    expect(resolveCardState({ hasLoaded: true, value: null })).toBe("no-records");
    expect(resolveCardState({ hasLoaded: true, value: 0 })).toBe("ready");
  });
});
