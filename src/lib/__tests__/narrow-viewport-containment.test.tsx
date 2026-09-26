// @vitest-environment jsdom
/**
 * Containment at phone and tablet widths.
 *
 * jsdom has no layout engine, so containment is proved structurally: every
 * surface that can receive unbounded content (a long identifier, a full
 * timestamp, an action cluster) must carry the contract that makes overflow
 * impossible — min-w-0 on the flexible track, a scroll boundary on tables,
 * an overflow-clipping card, and actions that collapse into a menu instead of
 * being positioned outside their row.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import {
  Atomic,
  RecordTitle,
  ResponsiveRowActions,
  StatCard,
  TableScroll,
} from "@/components/common/DataDisplay";
import { StatusPill } from "@/components/common/DataDisplay";

afterEach(cleanup);

const LONG_ID = "GRN-2026-0000000481-SAVANNAH-CROWN-NAIROBI-WESTLANDS";
const LONG_STAMP = "Thursday, 27 August 2026 at 11:31:48 GMT+03:00";
const styles = readFileSync("src/styles.css", "utf8");
const notifications = readFileSync("src/routes/_shell.notifications.tsx", "utf8");

/** The two widths the contract is written for. */
const BREAKPOINTS = [360, 768];

describe.each(BREAKPOINTS)("at %ipx", (width) => {
  it("a KPI card clips its own long content", () => {
    const { container } = render(
      <div style={{ width }}>
        <StatCard label={LONG_ID} value={LONG_STAMP} hint={LONG_ID} />
      </div>,
    );
    // The card itself clips: nothing inside it can paint past its radius.
    expect(container.querySelector(".overflow-hidden")).not.toBeNull();
    // The flexible track can shrink, so the icon well can never push text out.
    expect(container.querySelector(".grid.min-w-0")).not.toBeNull();
  });

  it("a table scrolls inside its boundary instead of widening the page", () => {
    const { container } = render(
      <div style={{ width }}>
        <TableScroll>
          <table>
            <tbody>
              <tr>
                <td>{LONG_ID}</td>
                <td>{LONG_STAMP}</td>
              </tr>
            </tbody>
          </table>
        </TableScroll>
      </div>,
    );
    expect((container.querySelector(".neo-table-scroll") as HTMLElement).className).toContain(
      "neo-table-scroll",
    );
  });

  it("row actions collapse into an overflow menu rather than escaping the row", () => {
    const { container } = render(
      <div style={{ width }}>
        <ResponsiveRowActions
          primary={<button type="button">Open</button>}
          secondary={[
            { label: "Record payment", onSelect: () => {} },
            { label: "Check out", onSelect: () => {} },
            { label: "Revert check-in", onSelect: () => {} },
          ]}
        />
      </div>,
    );
    const cluster = container.querySelector("[data-action-cluster]") as HTMLElement;
    expect(cluster.className).toContain("neo-row-actions");
    // Inline actions are hidden below md; the phone gets one menu button.
    expect(container.querySelector("span.hidden.md\\:inline-flex")).not.toBeNull();
    expect(container.querySelector("[data-overflow-actions]")).not.toBeNull();
    // Inline labels live in the md-only track, so a phone shows one control
    // rather than a concatenated "Record paymentCheck out" run.
    const inline = container.querySelector("span.hidden.md\\:inline-flex") as HTMLElement;
    expect(inline.textContent).toContain("Record payment");
    expect(cluster.querySelectorAll("button").length).toBeGreaterThan(0);
  });

  it("long identifiers and timestamps stay atomic or ellipsised", () => {
    const { container } = render(
      <div style={{ width }}>
        <RecordTitle>{LONG_ID}</RecordTitle>
        <Atomic>{LONG_STAMP}</Atomic>
        <StatusPill tone="warning">Awaiting settlement</StatusPill>
      </div>,
    );
    expect((container.querySelector("span.neo-line-1") as HTMLElement).className).toContain(
      "neo-line-1",
    );
    expect(container.querySelector("span.neo-atomic")).not.toBeNull();
  });
});

describe("containment utilities", () => {
  it("the row-action cluster is bounded and never wraps out of the row", () => {
    const block = styles.slice(styles.indexOf("@utility neo-row-actions {"));
    const css = block.slice(0, block.indexOf("\n}"));
    expect(css).toContain("max-width: 100%");
    expect(css).toContain("min-width: 0");
  });

  it("the page gutter is safe-area aware so content never touches the edge", () => {
    expect(styles).toContain("neo-page-gutter");
    expect(styles).toContain("env(safe-area-inset-");
  });
});

describe("notifications stay inside their card", () => {
  it("pairs the title with the badge on a shrinkable track", () => {
    expect(notifications).toContain("grid min-w-0 grid-cols-[minmax(0,1fr)_auto]");
  });

  it("clips each notice and routes its actions through the responsive cluster", () => {
    expect(notifications).toContain("overflow-hidden rounded-xl border");
    expect(notifications).toContain("<ResponsiveRowActions");
  });

  it("never positions an action absolutely over the content", () => {
    expect(notifications).not.toMatch(/className="[^"]*\babsolute\b/);
  });

  it("keeps the inbox above commitments", () => {
    const inbox = notifications.indexOf("TabsContent");
    const commitments = notifications.indexOf("CommitmentsInbox");
    expect(inbox).toBeGreaterThan(-1);
    if (commitments > -1) expect(commitments).toBeGreaterThan(inbox);
  });
});

describe("no staff route reintroduces an unbounded table", () => {
  const routes = readdirSync("src/routes").filter((f) => f.startsWith("_shell."));

  it("every route rendering a table imports the shared scroll boundary", () => {
    const offenders = routes.filter((f) => {
      const src = readFileSync(`src/routes/${f}`, "utf8");
      // Either shared primitive is a boundary; a bare table is not.
      return (
        src.includes("<Table>") &&
        !src.includes("TableScroll") &&
        !src.includes("overflow-x-auto")
      );
    });
    expect(offenders).toEqual([]);
  });
});
