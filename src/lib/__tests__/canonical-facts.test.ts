import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FACTS,
  FACT_METRIC_PREFIX,
  factPathOf,
  factValue,
  formatFact,
  isFactMetric,
} from "@/lib/facts";
import { SHARED_FACT_PATHS } from "@/components/common/FactSection";
import { DASHBOARDS } from "@/lib/dashboards";
import { METRIC_CONTRACTS, cardContract } from "@/lib/data-sources";
import { factExportCsv } from "@/lib/fact-export";

const read = (p: string) => readFileSync(p, "utf8");

describe("canonical fact layer", () => {
  it("every fact declares an eligibility rule and a drill-down to its source records", () => {
    for (const [path, def] of Object.entries(FACTS)) {
      expect(def.path, path).toBe(path);
      expect(def.eligibility.length, path).toBeGreaterThan(20);
      expect(def.drillTo.startsWith("/"), path).toBe(true);
    }
  });

  it("operational sales, forecast, collections and posted revenue are separate facts", () => {
    for (const key of [
      "operational.pos_finalised_sales",
      "operational.pos_open_value",
      "events.confirmed_forecast",
      "events.invoiced",
      "collections.total",
      "accounting.posted_revenue",
      "accounting.net_recognised_revenue",
    ]) {
      expect(FACTS[key], key).toBeDefined();
    }
    // Forecast is never described as accounting revenue.
    expect(FACTS["events.confirmed_forecast"]!.eligibility.toLowerCase()).toContain("forecast");
    expect(FACTS["operational.pos_open_value"]!.eligibility.toLowerCase()).toContain(
      "never counted as revenue",
    );
    // Draft/served POS states are explicitly excluded from recognised revenue.
    expect(FACTS["operational.pos_finalised_sales"]!.eligibility.toLowerCase()).toContain("draft");
  });

  it("every dashboard fact KPI resolves to a fact definition and a metric contract", () => {
    const factKpis = Object.values(DASHBOARDS)
      .flatMap((s) => s.widgets)
      .filter((w) => w.kind === "kpi" && isFactMetric((w as { metric?: string }).metric));
    expect(factKpis.length).toBeGreaterThan(0);
    for (const w of factKpis) {
      const metric = (w as { metric: string }).metric;
      expect(FACTS[factPathOf(metric)], metric).toBeDefined();
      expect(METRIC_CONTRACTS[metric], metric).toBeDefined();
      expect(cardContract(w.id, metric), metric).toBeDefined();
      expect(["neo_facts", "neo_front_office_facts", "neo_operational_facts"]).toContain(METRIC_CONTRACTS[metric]!.service);
    }
  });

  it("revenue, occupancy, receivables and payables are no longer 'awaiting module'", () => {
    const owner = DASHBOARDS["owner"]!;
    for (const id of ["revenue-today", "revenue-week", "revenue-month", "occupancy", "receivables", "payables"]) {
      const w = owner.widgets.find((x) => x.id === id);
      expect(w, id).toBeDefined();
      expect(w!.source, id).toBe("live");
    }
  });

  it("dashboard, analytics, finance and reports read the same fact layer", () => {
    const frame = read("src/components/dashboard/DashboardFrame.tsx");
    const analytics = read("src/routes/_shell.analytics.index.tsx");
    const finance = read("src/routes/_shell.finance.index.tsx");
    const reports = read("src/routes/_shell.reports.tsx");
    expect(frame).toContain("useFacts");
    for (const src of [analytics, finance, reports]) {
      expect(src).toContain("FactSection");
    }
    expect(analytics).toContain("SHARED_FACT_PATHS");
    expect(finance).toContain("SHARED_FACT_PATHS");
    for (const p of SHARED_FACT_PATHS) expect(FACTS[p], p).toBeDefined();
  });

  it("never exports monetary rows when the scoped payload denies monetary access", () => {
    const csv = factExportCsv({
      facts: {
        monetary_authorised: false,
        rooms: { occupancy_rate: 64 },
        accounting: { net_recognised_revenue: 999999 },
      },
      paths: ["rooms.occupancy_rate", "accounting.net_recognised_revenue"],
      reconciliation: [],
      scope: { branchId: null, from: "2026-08-01", to: "2026-08-23" },
      scopeLabel: "Authorised scope",
    });
    expect(csv).toContain("Occupancy");
    expect(csv).not.toContain("Net recognised revenue");
    expect(csv).not.toContain("999999");
  });

  it("builds PDF exports from all three canonical scoped fact services", () => {
    const source = read("src/lib/report-pdf.server.ts");
    expect(source).toContain('supabase.rpc("neo_facts"');
    expect(source).toContain('supabase.rpc("neo_front_office_facts"');
    expect(source).toContain('supabase.rpc("neo_operational_facts"');
    expect(source).toContain('factPayload["monetary_authorised"] === true');
  });

  it("reads nested fact paths and never invents a value", () => {
    const payload = { accounting: { revenue_today: 1500 }, rooms: { occupancy_rate: null } };
    expect(factValue(payload, "accounting.revenue_today")).toBe(1500);
    expect(factValue(payload, "rooms.occupancy_rate")).toBeNull();
    expect(factValue(payload, "missing.path")).toBeNull();
    expect(factValue(undefined, "accounting.revenue_today")).toBeNull();
  });

  it("formats money, percentages and counts without fabricating zeroes", () => {
    expect(formatFact(null, "money", "KES")).toBe("—");
    expect(formatFact(0, "money", "KES")).toBe("KES 0");
    expect(formatFact(62.55, "percent")).toBe("62.5%");
    expect(formatFact(9, "count")).toBe("9");
  });

  it("fact metrics are namespaced so they never collide with dashboard_metrics paths", () => {
    expect(isFactMetric("tasks.open")).toBe(false);
    expect(isFactMetric(`${FACT_METRIC_PREFIX}collections.total`)).toBe(true);
    expect(factPathOf(`${FACT_METRIC_PREFIX}collections.total`)).toBe("collections.total");
    for (const key of Object.keys(METRIC_CONTRACTS)) {
      if (isFactMetric(key))
        expect(["neo_facts", "neo_front_office_facts", "neo_operational_facts"]).toContain(
          METRIC_CONTRACTS[key]!.service,
        );
      else expect(METRIC_CONTRACTS[key]!.service).not.toBe("neo_facts");
    }
  });
});
