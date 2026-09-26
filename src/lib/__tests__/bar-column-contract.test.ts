import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Bar module reads POS money from `pos_orders.grand_total` / `paid_total`.
 * `total_amount` does not exist on that table, and referencing it used to break
 * the whole Bar dashboard with a schema error. This guard fails if it returns.
 */
const BAR_SOURCES = [
  "src/lib/bar.ts",
  "src/routes/_shell.bar.index.tsx",
  "src/routes/_shell.bar.sell.tsx",
  "src/routes/_shell.bar.menu.tsx",
  "src/routes/_shell.bar.queue.tsx",
  "src/routes/_shell.bar.wastage.tsx",
  "src/routes/_shell.bar.requisitions.tsx",
];

describe("bar column contract", () => {
  it("never references a non-existent pos_orders.total_amount column", () => {
    for (const file of BAR_SOURCES) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must not reference total_amount`).not.toMatch(/total_amount/);
    }
  });

  it("reads bar order value from the canonical grand_total field", () => {
    const bar = readFileSync("src/lib/bar.ts", "utf8");
    expect(bar).toContain("grand_total");
    expect(bar).toContain("paid_total");
  });

  it("routes every bar dashboard figure through a scoped server reader", () => {
    const bar = readFileSync("src/lib/bar.ts", "utf8");
    expect(bar).toContain("neo_bar_overview");
    const dashboard = readFileSync("src/routes/_shell.bar.index.tsx", "utf8");
    expect(dashboard).toContain("useBarOverview");
  });

  it("narrows shared F&B lists down to the Bar department", () => {
    const requisitions = readFileSync("src/routes/_shell.bar.requisitions.tsx", "utf8");
    const wastage = readFileSync("src/routes/_shell.bar.wastage.tsx", "utf8");
    expect(requisitions).toContain("filterToBarScope");
    expect(wastage).toContain("filterToBarScope");
  });
});
