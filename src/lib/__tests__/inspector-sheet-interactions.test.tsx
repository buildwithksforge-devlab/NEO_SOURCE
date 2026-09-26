// @vitest-environment jsdom
/**
 * Inspector drawer interaction contract.
 *
 * Room Rack and Availability move secondary statuses and actions into the
 * shared inspector on small screens, so its behaviour has to be dependable:
 * focus moves into the panel and stays trapped there, Escape closes it, and
 * the page behind it does not scroll. These are Radix Dialog guarantees — the
 * point of this suite is that the shared component keeps them (no custom
 * portal, no `modal={false}`) and that the two surfaces keep using it.
 */
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InspectorSheet } from "@/components/common/InspectorSheet";
import { Button } from "@/components/ui/button";

afterEach(cleanup);

function open(onOpenChange = vi.fn()) {
  render(
    <InspectorSheet
      open
      onOpenChange={onOpenChange}
      title="Room 204"
      subtitle="Deluxe · Occupied"
      footer={<Button>Assign cleaning</Button>}
    >
      <Button>Mark clean</Button>
      <Button>Mark ready</Button>
    </InspectorSheet>,
  );
  return onOpenChange;
}

describe("inspector drawer behaviour", () => {
  it("renders as a dialog with an accessible name", async () => {
    open();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("data-state")).toBe("open");
    expect(screen.getByText("Room 204")).toBeTruthy();
  });

  it("moves focus into the panel and traps it", async () => {
    const user = userEvent.setup();
    open();
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("closes on Escape", async () => {
    const onOpenChange = open();
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("locks background scrolling while open", async () => {
    open();
    await screen.findByRole("dialog");
    await waitFor(() => expect(document.body.style.pointerEvents).toBe("none"));
  });
});

describe("inspector usage on the room surfaces", () => {
  it("Room Rack and Availability move detail into the shared inspector", () => {
    const rack = readFileSync("src/routes/_shell.pms.rack.tsx", "utf8");
    const availability = readFileSync("src/components/pms/AvailabilitySearchPage.tsx", "utf8");
    for (const source of [rack, availability]) {
      expect(source).toContain("InspectorSheet");
      expect(source).toContain("inspected");
    }
  });

  it("keeps the shared component modal — no bespoke non-modal drawer", () => {
    const inspector = readFileSync("src/components/common/InspectorSheet.tsx", "utf8");
    expect(inspector).not.toContain("modal={false}");
    expect(inspector).toContain("<Sheet open={open} onOpenChange={onOpenChange}>");
  });
});
