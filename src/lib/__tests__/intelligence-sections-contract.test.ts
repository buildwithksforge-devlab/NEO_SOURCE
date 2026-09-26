import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTELLIGENCE_SECTIONS } from "@/components/intelligence/IntelligenceShell";

const route = readFileSync("src/routes/_shell.ai-insights.tsx", "utf8");

describe("NEØ Intelligence section contract", () => {
  it("declares exactly the seven approved sections in order", () => {
    expect(INTELLIGENCE_SECTIONS.map((s) => s.label)).toEqual([
      "Executive Pulse",
      "Revenue & Demand",
      "Guest Experience",
      "Operational Risk",
      "Cost & Inventory",
      "Workforce",
      "Recommendations",
    ]);
  });

  it("renders every section on the Intelligence route", () => {
    for (const section of INTELLIGENCE_SECTIONS) {
      expect(route).toContain(`id="${section.id}"`);
    }
  });

  it("keeps the branded hero and section rail on the route", () => {
    expect(route).toContain("<IntelligenceHero");
    expect(route).toContain("<IntelligenceRail");
  });

  it("never fabricates data for empty sections", () => {
    expect(route).toContain("AwaitingData");
    expect(route).not.toMatch(/Math\.random|sampleData|demoData/);
  });
});
