// @vitest-environment jsdom
/**
 * Shared staff header: layout and progressive disclosure.
 *
 * Static class assertions are deliberate — jsdom has no layout engine, so the
 * contract is expressed as the responsive rules that keep the single row from
 * overflowing: fixed-size controls shrink-0, text containers min-w-0 + truncate,
 * and lower-priority utilities collapsing into the More menu rather than being
 * deleted. Breakpoints reasoned about: 360/390, 430, 768/820/834, 1024, desktop.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clockParts } from "@/components/layout/LiveClock";

const topbar = readFileSync("src/components/layout/Topbar.tsx", "utf8");
const selector = readFileSync("src/components/layout/PropertySelector.tsx", "utf8");
const clock = readFileSync("src/components/layout/LiveClock.tsx", "utf8");

describe("header date and time presentation", () => {
  const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const MONTHS = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];

  it("uses the exact THU 27 AUG '26 pattern", () => {
    expect(clockParts(new Date("2026-08-27T09:03:00Z"), "Africa/Nairobi").date).toBe(
      "THU 27 AUG '26",
    );
  });

  it("emits only the approved day and month abbreviations across a year", () => {
    for (let m = 0; m < 12; m += 1) {
      for (const day of [1, 15, 28]) {
        const parts = clockParts(new Date(Date.UTC(2026, m, day, 9, 3)), "Africa/Nairobi");
        const [weekday, dd, month, year] = parts.date.split(" ");
        expect(DAYS).toContain(weekday);
        expect(MONTHS).toContain(month);
        expect(dd).toMatch(/^\d{2}$/);
        expect(year).toMatch(/^'\d{2}$/);
      }
    }
  });

  it("shows a 12-hour time with no seconds", () => {
    for (const iso of ["2026-08-27T09:03:00Z", "2026-01-02T21:45:30Z", "2026-06-30T00:00:00Z"]) {
      const t = clockParts(new Date(iso), "Africa/Nairobi").time;
      expect(t).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
      expect(t).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
    }
  });

  it("renders the time stronger than the date and keeps the zone quiet", () => {
    expect(clock).toMatch(/text-sm font-semibold tabular-nums text-foreground/);
    expect(clock).toMatch(/text-\[0\.68rem\] font-medium uppercase[^"]*text-muted-foreground/);
    // The EAT zone label stays put wherever the clock itself is shown — it must
    // not vanish at tablet widths that clearly have room for it.
    expect(clock).toContain("text-muted-foreground/70");
    expect(clock).not.toContain("lg:inline");
    expect(clock).toContain("whitespace-nowrap");
    // Live clock and timezone resolution are unchanged.
    expect(clock).toContain("useActiveTimezone");
    expect(clock).toContain("setInterval");
  });
});

describe("header single-row containment", () => {
  it("keeps the row itself from overflowing horizontally", () => {
    // Full-bleed shell chrome: no max-width stops the header early.
    expect(topbar).toContain("neo-shell-bleed flex h-16 items-center");
    expect(topbar).not.toContain("max-w-7xl");
    expect(topbar).toContain("overflow-hidden");
    // Safe-area aware gutters come from the shared page gutter utility.
    expect(topbar).toContain("neo-page-gutter");
  });

  it("lets text compress and keeps fixed controls from being clipped", () => {
    expect(topbar).toContain("neo-module-label");
    expect((topbar.match(/shrink-0/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("keeps the NEØ mark permanent with its home navigation", () => {
    expect(topbar).toMatch(/<Link\s+to="\/workspace"[\s\S]*?NeoGlyph/);
    expect(topbar).not.toContain("tenantLogo");
  });

  it("derives the module label from the route, not from per-page props", () => {
    expect(topbar).toContain("useRouterState");
    expect(topbar).toContain("CONTEXT_LABELS");
    expect(topbar).toContain("data-module-label");
  });
});

describe("progressive disclosure by width", () => {
  it("phone (360-430): only high-attention utilities stay inline", () => {
    // AI + notifications carry no hidden-below-breakpoint class.
    expect(topbar).toContain('<IconAction label="NEØ Intelligence" className="hidden text-primary sm:inline-flex">');
    expect(topbar).toContain('aria-label="Notifications"');
    // Tasks/approvals/bug/theme move into the overflow menu instead of vanishing.
    expect(topbar).toContain('<IconAction label="Tasks" className="hidden lg:inline-flex">');
    expect(topbar).toContain('<IconAction label="Approvals" className="hidden md:inline-flex">');
    expect(topbar).toContain('data-header-overflow');
    expect(topbar).toContain('className="lg:hidden"'); // Tasks in More
    expect(topbar).toContain('className="md:hidden"'); // Approvals in More
    expect(topbar).toContain('<ReportProblemDialog variant="menu" />');
    expect(topbar).toContain("Toggle theme");
  });

  it("phone: the property selector is reachable from the profile sheet", () => {
    expect(topbar).toContain('<PropertySelector className="flex w-auto max-w-[8.5rem] sm:max-w-[15rem]" />');
    expect(topbar).toContain('<PropertySelector className="w-full max-w-none" />');
  });

  it("tablet/desktop: the More trigger disappears once everything fits inline", () => {
    expect(topbar).toContain("lg:hidden");
    expect(topbar).toContain('<div className="hidden lg:flex lg:items-center lg:gap-0.5">');
  });

  it("loses no utility in any configuration", () => {
    for (const fn of ["/tasks", "/approvals", "/ai-insights", "/notifications"]) {
      // once inline, once in the overflow menu
      expect((topbar.match(new RegExp(`to="${fn}"`, "g")) ?? []).length).toBeGreaterThanOrEqual(1);
    }
    expect(topbar).toContain("ReportProblemDialog");
    expect(topbar).toContain("toggleTheme");
  });
});

describe("property selector and profile treatment", () => {
  it("selector is a compact, touch-sized, truncating one-line control", () => {
    expect(selector).toContain("h-10");
    expect(selector).toContain("max-w-[15rem]");
    expect(selector).toContain("[&>span]:truncate");
    expect(selector).toContain("<Building2");
    // Switching and scoping behaviour untouched.
    expect(selector).toContain("useBranchScope");
    expect(selector).toContain("setActiveBranchId(v)");
  });

  it("profile trigger is compact and responsive, dropdown stays in the viewport", () => {
    expect(topbar).toContain("max-w-[13rem]");
    expect(topbar).toContain('className="hidden min-w-0 text-xs leading-tight md:block"');
    expect(topbar).toContain("block truncate font-semibold");
    expect(topbar).toContain("w-[min(16rem,calc(100vw-1.5rem))]");
  });

  it("retains the existing profile actions and adds none", () => {
    for (const action of [
      "/profile",
      "/hr/me",
      "/my-engagement",
      "/admin/branches",
      "Account security",
      "Sign out",
    ]) {
      expect(topbar).toContain(action);
    }
  });

  it("uses quiet brand accents rather than heavy pills", () => {
    expect(topbar).toContain("hover:bg-primary-soft/60");
    expect(topbar).toContain("rounded-xl");
    expect(topbar).not.toContain("rounded-full bg-foreground");
  });
});
