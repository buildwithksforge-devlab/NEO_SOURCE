// @vitest-environment jsdom
/**
 * The one-line contract.
 *
 * A KPI label, a short card title, money, a date, a room number and a status
 * are atomic: at every breakpoint they stay on one line and ellipsize rather
 * than tearing into one word per row. Supporting prose may still wrap.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { Atomic, RecordTitle, StatCard, StatusPill } from "@/components/common/DataDisplay";

afterEach(cleanup);

const styles = readFileSync("src/styles.css", "utf8");
const utility = (name: string) => {
  const start = styles.indexOf(`@utility ${name} {`);
  if (start === -1) return "";
  return styles.slice(start, styles.indexOf("\n}", start));
};

/** Values that must never break, whatever the viewport. */
const ATOMIC_VALUES = [
  { kind: "money", value: "KSh 1,284,900.00" },
  { kind: "date", value: "27 Aug 2026, 11:31" },
  { kind: "room number", value: "Room 1204-B" },
  { kind: "status", value: "Awaiting settlement" },
  { kind: "identifier", value: "FOL-2026-0000481-SAV" },
];

describe("one-line utilities", () => {
  it("neo-line-1 truncates instead of wrapping", () => {
    const css = utility("neo-line-1");
    expect(css).toContain("white-space: nowrap");
    expect(css).toContain("text-overflow: ellipsis");
    expect(css).toContain("overflow: hidden");
    expect(css).toContain("min-width: 0");
  });

  it("neo-atomic keeps figures unbroken with tabular numerals", () => {
    const css = utility("neo-atomic");
    expect(css).toContain("white-space: nowrap");
    expect(css).toContain("tabular-nums");
  });

  it("is breakpoint independent — no media query relaxes the rule", () => {
    for (const name of ["neo-line-1", "neo-atomic"]) {
      expect(utility(name)).not.toContain("@media");
    }
  });
});

describe("KPI cards keep label and figure on one line", () => {
  for (const { kind, value } of ATOMIC_VALUES) {
    it(`holds a ${kind} value on one line`, () => {
      const { container } = render(
        <StatCard label="Outstanding folio balance for the property" value={value} />,
      );
      const label = container.querySelector("p.neo-line-1");
      const figure = container.querySelector("p.neo-metric-value");
      expect(label?.textContent).toBe("Outstanding folio balance for the property");
      // The full text is preserved for assistive tech even when clipped.
      expect(label?.getAttribute("title")).toBe("Outstanding folio balance for the property");
      expect(figure?.className).toContain("neo-line-1");
      expect(figure?.textContent).toBe(value);
      expect(figure?.getAttribute("title")).toBe(value);
    });
  }

  it("keeps supporting hint text wrappable", () => {
    const { container } = render(
      <StatCard label="Occupancy" value="82%" hint="42 of 51 sellable rooms are occupied tonight" />,
    );
    const hint = container.querySelector("span.text-xs");
    expect(hint?.className).not.toContain("neo-line-1");
    expect(hint?.className).toContain("min-w-0");
  });
});

describe("short titles, atoms and status pills", () => {
  it("record titles are single line with a full-text title attribute", () => {
    const { container } = render(<RecordTitle>Deluxe Twin — Savannah Crown Nairobi</RecordTitle>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("neo-line-1");
    expect(el.getAttribute("title")).toBe("Deluxe Twin — Savannah Crown Nairobi");
  });

  it("Atomic marks money/date/id runs as unbreakable", () => {
    for (const { value } of ATOMIC_VALUES) {
      cleanup();
      const { container } = render(<Atomic>{value}</Atomic>);
      expect((container.firstElementChild as HTMLElement).className).toContain("neo-atomic");
    }
  });

  it("status pills never wrap their label", () => {
    const { container } = render(<StatusPill tone="warning">Awaiting settlement</StatusPill>);
    expect((container.firstElementChild as HTMLElement).className).toMatch(
      /whitespace-nowrap|neo-atomic/,
    );
  });
});
