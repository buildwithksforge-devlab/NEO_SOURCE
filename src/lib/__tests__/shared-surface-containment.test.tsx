// @vitest-environment jsdom
/**
 * Containment regression for the shared surface primitives at phone (360px)
 * and tablet (768px) widths.
 *
 * jsdom has no layout engine, so containment is asserted structurally: every
 * surface that can receive unbounded content must carry the contract that
 * makes overflow impossible — a shrinkable text track (min-w-0), a clipping
 * card, single-line clamping on titles and identifiers, and actions that
 * collapse rather than escape. A regression here is a title that wraps or a
 * value that paints past its card on a phone.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import {
  PageHeader,
  RecordTitle,
  SectionCard,
  StatCard,
  StatusPill,
} from "@/components/common/DataDisplay";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotAuthorisedState,
  NotConfiguredState,
} from "@/components/common/StateSystem";

afterEach(cleanup);

const LONG_TITLE =
  "Savannah Crown Nairobi Westlands — Front Office Departure Reconciliation Commitment";
const LONG_VALUE = "KES 12,480,995.75";
const BREAKPOINTS = [360, 768];

const styles = readFileSync("src/styles.css", "utf8");
const notifications = readFileSync("src/routes/_shell.notifications.tsx", "utf8");
const commitments = readFileSync("src/components/common/CommitmentsInbox.tsx", "utf8");

describe.each(BREAKPOINTS)("shared surfaces at %ipx", (width) => {
  const at = (node: React.ReactNode) => render(<div style={{ width }}>{node}</div>);

  it("the page hero keeps its title on a shrinkable track and clips itself", () => {
    const { container } = at(
      <PageHeader
        eyebrow="Delivery Department"
        title={LONG_TITLE}
        description={LONG_TITLE}
        meta={<StatusPill tone="warning">12 need action</StatusPill>}
      />,
    );
    const hero = container.querySelector(".neo-page-hero") as HTMLElement | null;
    expect(hero).not.toBeNull();
    expect(container.querySelector(".min-w-0")).not.toBeNull();
    expect(hero!.className).toMatch(/overflow-hidden/);
  });

  it("a lead KPI card clips and shrinks rather than widening the grid", () => {
    const { container } = at(<StatCard lead label={LONG_TITLE} value={LONG_VALUE} hint={LONG_TITLE} />);
    expect(container.querySelector(".overflow-hidden")).not.toBeNull();
    expect(container.querySelector(".min-w-0")).not.toBeNull();
    // The value uses the fluid metric type so it scales instead of overflowing.
    expect(container.innerHTML).toContain("neo-metric-value");
  });

  it("a section card clips its own content", () => {
    const { container } = at(
      <SectionCard title={LONG_TITLE} description={LONG_TITLE}>
        <RecordTitle>{LONG_TITLE}</RecordTitle>
      </SectionCard>,
    );
    expect(container.querySelector(".neo-line-1")).not.toBeNull();
    expect(container.innerHTML).toContain("min-w-0");
  });

  it.each([
    ["loading", <LoadingState key="l" />],
    ["empty", <EmptyState key="e" title={LONG_TITLE} description={LONG_TITLE} />],
    ["error", <ErrorState key="x" error={new Error(LONG_TITLE)} />],
    ["not configured", <NotConfiguredState key="c" feature={LONG_TITLE} detail={LONG_TITLE} />],
    ["not authorised", <NotAuthorisedState key="a" subject={LONG_TITLE} />],
  ])("the shared %s state stays inside its container", (_label, node) => {

    const { container } = at(node);
    const root = container.firstElementChild as HTMLElement;
    expect(root).not.toBeNull();
    // No state panel may set a fixed pixel width or a negative margin.
    expect(root.outerHTML).not.toMatch(/\bw-\[\d+px\]/);
    expect(root.outerHTML).not.toMatch(/\b-m[xytblr]?-/);
  });
});

describe("feed surfaces are contained by contract", () => {
  it("notification rows pair title and badge on a shrinkable two-track grid", () => {
    expect(notifications).toContain("grid min-w-0 grid-cols-[minmax(0,1fr)_auto]");
    expect(notifications).toContain("overflow-hidden rounded-xl border");
    expect(notifications).toContain("neo-line-2");
  });

  it("commitment rows clamp their text and never float their action", () => {
    expect(commitments).toContain("grid min-w-0 grid-cols-[minmax(0,1fr)_auto]");
    expect(commitments).toContain("overflow-hidden rounded-xl border");
    expect(commitments).toContain("neo-line-1");
    expect(commitments).not.toMatch(/className="[^"]*\babsolute\b/);
  });

  it("commitments use the shared state language rather than ad-hoc markup", () => {
    expect(commitments).toContain("QueryState");
    expect(commitments).toContain("EmptyState");
    expect(commitments).not.toContain("Loading…");
  });
});

describe("containment utilities exist for the updated surfaces", () => {
  it.each(["neo-page-hero", "neo-icon-well", "neo-line-1", "neo-line-2", "neo-contain"])(
    "%s is defined",
    (utility) => {
      expect(styles).toContain(`@utility ${utility}`);
    },
  );
});
