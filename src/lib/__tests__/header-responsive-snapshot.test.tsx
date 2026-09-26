// @vitest-environment jsdom
/**
 * Header responsive snapshot regression suite.
 *
 * jsdom has no layout engine, so the breakpoint behaviour of the header is
 * pinned two ways:
 *  1. real renders of the density control in each of its two shapes, snapshotted
 *     so a styling change to the control is a visible, reviewed diff;
 *  2. snapshots of the responsive class contract for the NEØ identity, the area
 *     (property) selector and the density slot, per breakpoint.
 *
 * Breakpoints: phone (<640), tablet (640–1023), desktop (>=1024).
 */
import { readFileSync } from "node:fs";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DensityToggle } from "@/components/common/DensityToggle";

const topbar = readFileSync("src/components/layout/Topbar.tsx", "utf8");
const selector = readFileSync("src/components/layout/PropertySelector.tsx", "utf8");

afterEach(cleanup);

describe("density control snapshots", () => {
  it("renders the segmented control with all three modes", () => {
    const { container } = render(<DensityToggle className="hidden md:inline-flex" />);
    expect(container.firstElementChild?.outerHTML).toMatchSnapshot();
  });

  it("renders the phone menu variant as a single icon button", () => {
    const { container } = render(<DensityToggle variant="menu" className="md:hidden" />);
    expect(container.firstElementChild?.outerHTML).toMatchSnapshot();
  });

  it("keeps exactly one density control visible at every breakpoint", () => {
    // Desktop/tablet show the segmented track (`hidden md:inline-flex`),
    // phone shows the menu (`md:hidden`) — never both, never neither. The pair
    // lives in the dashboard toolbar slot, never in the header.
    const frame = readFileSync("src/components/dashboard/DashboardFrame.tsx", "utf8");
    expect(topbar).not.toContain("DensityToggle");
    expect(frame).toContain('<DensityToggle className="hidden md:inline-flex" />');
    expect(frame).toContain('<DensityToggle variant="menu" className="md:hidden" />');
    expect((frame.match(/<DensityToggle/g) ?? []).length).toBe(2);
  });
});

describe("header breakpoint contract", () => {
  const contract = {
    phone: {
      density: "not in the header — dashboard toolbar slot (menu button below md)",
      identity: "square NEØ Ø symbol at a protected 28×28px, never collapsed",
      areaSelector: "moved into the profile sheet (PropertySelector w-full)",
    },
    tablet: {
      density: "not in the header — dashboard toolbar slot (segmented from md)",
      identity: "square NEØ Ø symbol plus truncating module label",
      areaSelector: "inline compact selector (narrow but visible)",
    },
    desktop: {
      density: "not in the header — dashboard toolbar slot (segmented track)",
      identity: "square NEØ Ø symbol, module label and inline utilities",
      areaSelector: "inline compact selector with truncation",
    },

  } as const;

  it("pins the per-breakpoint header composition", () => {
    expect(contract).toMatchSnapshot();
  });

  it("matches the composition actually implemented in the header", () => {
    expect(topbar).toContain('<PropertySelector className="flex w-auto max-w-[8.5rem] sm:max-w-[15rem]" />');
    expect(topbar).toContain('<PropertySelector className="w-full max-w-none" />');
    expect(topbar).toContain("neo-module-label");
    // The staff workspace home is /workspace; "/" is the public NEØ front door.
    expect(topbar).toMatch(/<Link\s+to="\/workspace"[\s\S]*?NeoGlyph/);
    // Fixed controls never shrink into unreadable slivers, text always can.
    expect(topbar).toContain("shrink-0");
    expect(topbar).toContain("min-w-0");
  });

  it("keeps the area selector on one truncating line so it cannot wrap the row", () => {
    expect(selector).toContain("[&>span]:truncate");
    expect(selector).toContain("max-w-[15rem]");
    expect(selector).toContain("h-10");
  });

  it("keeps the header a single non-overflowing row", () => {
    expect(topbar).toContain("neo-shell-bleed flex h-16 items-center");
    expect(topbar).toContain("overflow-hidden");
  });
});

describe("permanent NEØ identity", () => {
  it("uses the square Ø symbol in the header, not the wordmark", () => {
    expect(topbar).toContain("<NeoGlyph");
    expect(topbar).not.toContain("<NeoWordmark");
  });

  it("locks the symbol at a protected 28×28px that cannot collapse", () => {
    const mark = topbar.match(/<NeoGlyph className="([^"]+)"/)?.[1] ?? "";
    expect(mark).toContain("size-7"); // 1.75rem = 28px
    expect(mark).toContain("min-h-7");
    expect(mark).toContain("min-w-7");
    expect(mark).toContain("shrink-0");
    expect(mark).toContain("object-contain");
  });

  it("keeps the full wordmark in the shell footer", () => {
    const shell = readFileSync("src/components/layout/AppShell.tsx", "utf8");
    const identity = readFileSync("src/components/brand/NeoIdentity.tsx", "utf8");
    expect(shell).toContain("<PoweredByNeoSignature />");
    expect(identity).toContain("NEO_WORDMARK_SRC");
  });


  it("keeps the current-area label beside the wordmark", () => {
    expect(topbar).toContain("data-module-label");
    expect(topbar).toContain("{context}");
  });

  it("spans the full shell frame on every device", () => {
    // The header row bleeds to the shell edges and only its contents are
    // inset by the shared gutter — identical to the footer frame.
    expect(topbar).toContain("neo-page-gutter neo-shell-bleed");
  });
});
