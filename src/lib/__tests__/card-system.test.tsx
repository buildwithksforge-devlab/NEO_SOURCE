// @vitest-environment jsdom
/**
 * The shared card standard is a contract, not a style suggestion: boards lay
 * cards out in equal-width columns, cards are full-height flex columns, the
 * body takes the spare space and the footer is pinned to the bottom, so
 * neighbouring cards align whatever their content length.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  CardBoard,
  NeoCard,
  NeoCardActions,
  NeoCardBody,
  NeoCardDescription,
  NeoCardFooter,
  NeoCardHeader,
  NeoCardMetric,
  NeoCardStatus,
  NeoCardTitle,
  NeoCardTableRegion,
} from "@/components/common/CardSystem";

function board(description: string) {
  return (
    <CardBoard columns={3}>
      <NeoCard>
        <NeoCardHeader>
          <NeoCardTitle hint="hint">Ready to post</NeoCardTitle>
          <NeoCardStatus tone="warning">Waiting</NeoCardStatus>
        </NeoCardHeader>
        <NeoCardBody>
          <NeoCardMetric>12</NeoCardMetric>
          <NeoCardDescription>{description}</NeoCardDescription>
        </NeoCardBody>
        <NeoCardFooter>
          <span>Queue</span>
          <NeoCardActions>
            <button type="button">Open</button>
          </NeoCardActions>
        </NeoCardFooter>
      </NeoCard>
    </CardBoard>
  );
}

describe("shared card system", () => {
  it("lays a board out in equal-width columns that stack responsively", () => {
    const { container } = render(board("short"));
    const grid = container.querySelector("[data-card-board]")!;
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("lg:grid-cols-3");
    // Equal row heights: every card in a row shares the tallest height.
    expect(grid.className).toContain("auto-rows-fr");
    expect(grid.className).toContain("items-stretch");
  });

  it("makes each card a full-height flex column with no fixed height", () => {
    const { container } = render(board("short"));
    const card = container.querySelector("[data-card]")!;
    expect(card.className).toContain("h-full");
    expect(card.className).toContain("flex-col");
    expect(card.className).not.toMatch(/\bh-\[/);
  });

  it("gives the body the flexible space and pins the footer to the bottom", () => {
    const { container } = render(board("short"));
    expect(container.querySelector("[data-card-body]")!.className).toContain("flex-1");
    expect(container.querySelector("[data-card-footer]")!.className).toContain("mt-auto");
  });

  it("keeps the same structure whatever the description length", () => {
    const short = render(board("short")).container.innerHTML;
    const long = render(
      board("a considerably longer description ".repeat(12)),
    ).container.innerHTML;
    const structure = (html: string) =>
      (html.match(/data-card-(header|body|footer|metric|status|actions)/g) ?? []).join(",");
    expect(structure(long)).toBe(structure(short));
  });

  it("truncates long values visually while keeping them readable", () => {
    const { container } = render(
      <NeoCard>
        <NeoCardBody>
          <NeoCardMetric title="SUP-INV-0000000000001048">SUP-INV-0000000000001048</NeoCardMetric>
        </NeoCardBody>
      </NeoCard>,
    );
    const metric = container.querySelector("[data-card-metric]")!;
    expect(metric.className).toContain("neo-line-1");
    expect(metric.getAttribute("title")).toBe("SUP-INV-0000000000001048");
  });

  it("scrolls a table inside the card rather than growing the page", () => {
    const { container } = render(
      <NeoCard>
        <NeoCardTableRegion>
          <table />
        </NeoCardTableRegion>
      </NeoCard>,
    );
    expect(container.querySelector("[data-card-table]")!.className).toContain("overflow-auto");
  });
});
