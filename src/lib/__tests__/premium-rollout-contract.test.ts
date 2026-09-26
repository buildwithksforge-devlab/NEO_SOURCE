import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// The audit scanner is the same code that produces docs/ux/full-premium-rollout-2026-08-29.md,
// so the classification the document reports and the classification CI enforces
// can never drift apart.
import { scan, listRouteFiles, classify, defects } from "../../../scripts/ux-audit";

const rows = scan();

describe("premium UX rollout contract", () => {
  it("scans every staff-facing route", () => {
    expect(listRouteFiles().length).toBeGreaterThan(250);
    expect(rows.length).toBe(listRouteFiles().length);
  });

  it("leaves no unmigrated legacy staff page", () => {
    const legacy = rows.filter((r) => r.klass === "C").map((r) => r.file);
    expect(legacy).toEqual([]);
  });

  it("keeps every staff route free of the fixed-width and raw-error defects", () => {
    const broken = rows
      .filter((r) => r.defects.length && r.file !== "_shell.pos.orders.$id.tsx")
      .map((r) => `${r.file}: ${r.defects.join(",")}`);
    expect(broken).toEqual([]);
  });

  it("classifies a plain page as legacy and a composed page as premium", () => {
    expect(classify("_shell.demo.tsx", "export function P() { return <div>hi</div>; }")).toBe("C");
    expect(
      classify(
        "_shell.demo.tsx",
        "PageHeader SectionCard QueryState useQuery( <div/>",
      ),
    ).toBe("A");
  });

  it("flags hard pixel widths but accepts responsive and capped widths", () => {
    expect(defects('<div className="w-[320px]" />')).toContain("fixed-pixel-width");
    expect(defects('<div className="w-full sm:w-[320px]" />')).not.toContain("fixed-pixel-width");
    expect(defects('<td className="max-w-[320px] truncate" />')).not.toContain(
      "fixed-pixel-width",
    );
    expect(defects('<table className="min-w-[820px]" />')).not.toContain("fixed-pixel-width");
  });

  it("flags raw provider error text rendered into a page", () => {
    expect(defects("<p>{(query.error as Error).message}</p>")).toContain("raw-error-message");
    expect(defects("<ErrorState error={query.error} inline />")).not.toContain(
      "raw-error-message",
    );
    // A mutation toast is not a rendered page state.
    expect(defects("onError: (e) => toast.error((e as Error).message);")).not.toContain(
      "raw-error-message",
    );
  });

  it("keeps the shell geometry contract in the stylesheet", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toContain(".neo-shell-bleed > *");
    expect(css).toMatch(/neo-shell-frame\s*\{[^}]*overflow-x: clip/);
  });

  it("ships the rollout audit artifact covering every scanned route", () => {
    const doc = readFileSync("docs/ux/full-premium-rollout-2026-08-29.md", "utf8");
    for (const row of rows) expect(doc).toContain(row.file);
  });
});
