import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * The KPI card is the most repeated surface in NEØ, so its visual contract is
 * policed here rather than route by route: a toned card must carry its tint,
 * a lead card must carry the brand wash, and short labels/figures must stay on
 * one line instead of tearing into one word per row.
 */
const card = readFileSync("src/components/common/DataDisplay.tsx", "utf8");
const tone = readFileSync("src/lib/tone.ts", "utf8");

describe("StatCard visual contract", () => {
  it("paints a whole-card wash for semantic tones", () => {
    expect(tone).toContain("TONE_TINT_SURFACE");
    expect(card).toContain("TONE_TINT_SURFACE[tone]");
  });

  it("gives the headline metric the brand wash", () => {
    expect(card).toContain("neo-card-lead");
    expect(card).toContain("neo-metric-value-lead");
  });

  it("keeps label and figure on one line", () => {
    const body = card.slice(card.indexOf("export function StatCard"));
    const stat = body.slice(0, body.indexOf("\n}\n"));
    expect(stat.match(/neo-line-1/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("puts the icon in a toned well that cannot shrink the label", () => {
    expect(card).toContain('cn("shrink-0 rounded-xl p-2"');
  });
});

describe("module dashboards use a lead KPI", () => {
  const routes = readdirSync("src/routes").filter(
    (f) => f.startsWith("_shell.") && f.endsWith(".index.tsx"),
  );

  it("marks one headline metric per module landing page", () => {
    const missing = routes.filter((f) => {
      const src = readFileSync(`src/routes/${f}`, "utf8");
      if (!src.includes("<StatCard")) return false;
      const first = src.slice(src.indexOf("<StatCard"));
      // The headline metric carries `lead` before any other prop.
      return !/^<StatCard\s+lead\b/.test(first.replace(/\s+/g, " "));
    });
    expect(missing).toEqual([]);
  });
});
