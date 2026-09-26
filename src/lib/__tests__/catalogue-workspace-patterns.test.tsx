// @vitest-environment jsdom
/**
 * The composition primitives introduced by the UX pass must behave as the
 * design contract states: summary figures are entry points into the work, the
 * rail selects without navigating, and the inspector groups detail into bands
 * rather than nested cards.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SummaryStrip } from "@/components/common/SummaryStrip";
import {
  CatalogueGroup,
  CatalogueRail,
  CatalogueRow,
} from "@/components/common/CatalogueWorkspace";
import { InspectorField, InspectorSection } from "@/components/common/InspectorSheet";

afterEach(() => cleanup());

describe("summary strip", () => {
  it("renders a lead figure and makes selectable figures real filter toggles", async () => {
    const onSelect = vi.fn();
    render(
      <SummaryStrip
        lead={{ id: "lead", label: "Sellable now", value: 214 }}
        figures={[
          {
            id: "routing",
            label: "Missing routing",
            value: 14,
            onSelect,
            active: false,
          },
        ]}
      />,
    );

    expect(screen.getByText("214")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /Missing routing/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(toggle);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("keeps a read-only figure out of the tab order", () => {
    render(<SummaryStrip lead={{ id: "lead", label: "Total", value: 3 }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("catalogue rail", () => {
  it("offers an All entry plus every taxonomy entry and reports selection", async () => {
    const onChange = vi.fn();
    render(
      <CatalogueRail
        title="Categories"
        items={[{ id: "Mains", label: "Mains", count: 12 }]}
        value="all"
        onChange={onChange}
        allLabel="All items"
        allCount={20}
      />,
    );

    // Rendered twice by design: chip row on phone, rail on laptop.
    const mains = screen.getAllByRole("button", { name: /Mains/ });
    expect(mains.length).toBeGreaterThan(0);
    await userEvent.click(mains[0]!);
    expect(onChange).toHaveBeenCalledWith("Mains");
  });
});

describe("catalogue row", () => {
  it("opens the inspector instead of navigating away", async () => {
    const onOpen = vi.fn();
    render(
      <CatalogueGroup label="Mains" count={1}>
        <CatalogueRow title="Grilled tilapia" subtitle="SKU-1" trailing="KES 1,200" onOpen={onOpen} />
      </CatalogueGroup>,
    );

    await userEvent.click(screen.getByRole("button", { name: /Grilled tilapia/ }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.getByText("KES 1,200")).toBeTruthy();
  });
});

describe("inspector sections", () => {
  it("groups detail with headings and label/value rows, not nested cards", () => {
    const { container } = render(
      <InspectorSection title="Pricing">
        <InspectorField label="Price">KES 1,200</InspectorField>
      </InspectorSection>,
    );

    expect(screen.getByRole("heading", { name: "Pricing" })).toBeTruthy();
    expect(screen.getByText("Price")).toBeTruthy();
    expect(container.querySelectorAll("[data-slot='card']").length).toBe(0);
  });
});
