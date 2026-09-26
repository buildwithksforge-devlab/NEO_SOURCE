import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("Notification centre layout", () => {
  it("renders the Inbox above Commitments and blocked items", () => {
    const src = read("src/routes/_shell.notifications.tsx");
    const inbox = src.indexOf('title="Inbox"');
    const commitments = src.lastIndexOf("<CommitmentsInbox />");
    expect(inbox).toBeGreaterThan(0);
    expect(commitments).toBeGreaterThan(inbox);
  });

  it("keeps the commitments section on the page", () => {
    expect(read("src/routes/_shell.notifications.tsx")).toContain("CommitmentsInbox");
  });
});

describe("Selected-state and label language", () => {
  it("badge metadata variants are tinted, never solid dark slabs", () => {
    const badge = read("src/components/ui/badge.tsx");
    expect(badge).toContain("secondary: \"border-outline-subtle bg-chip text-chip-foreground\"");
    expect(badge).toContain("vip:");
    expect(badge).toContain("bg-tint-accent text-on-tint-accent");
  });

  it("VIP guests render on the champagne tint, not a dark pill", () => {
    expect(read("src/components/pms/MovementBoard.tsx")).toContain('variant="vip"');
    expect(read("src/routes/_shell.pms.reservations.index.tsx")).toContain('variant="vip"');
    expect(read("src/routes/_shell.crm.customers.index.tsx")).toContain('tone="accent"');
  });

  it("check-in reconciliation warnings use the warning tint", () => {
    const src = read("src/components/pms/CheckInReconciliation.tsx");
    expect(src).not.toContain('return "secondary"');
    expect(src).toContain('return "warning"');
  });

  it("shared selected states use the theme tint, keeping the focus ring distinct", () => {
    const tabs = read("src/components/ui/tabs.tsx");
    expect(tabs).toContain("data-[state=active]:bg-chip-selected");
    expect(tabs).toContain("focus-visible:ring-ring");

    expect(read("src/components/ui/select.tsx")).toContain("data-[state=checked]:bg-chip-selected");
    expect(read("src/components/ui/dropdown-menu.tsx")).toContain(
      "data-[state=checked]:bg-chip-selected",
    );
    expect(read("src/components/ui/toggle.tsx")).toContain("data-[state=on]:bg-chip-selected");
    expect(read("src/components/ui/table.tsx")).toContain("data-[state=selected]:bg-primary-soft");
    expect(read("src/components/common/SectionTabs.tsx")).toContain("bg-chip-selected");
    expect(read("src/components/layout/PropertySelector.tsx")).toContain(
      "data-[state=checked]:bg-chip-selected",
    );
  });

  it("sidebar active item is a tint, not a navy slab", () => {
    const sidebar = read("src/components/layout/Sidebar.tsx");
    expect(sidebar).toContain("bg-sidebar-primary/12");
    expect(sidebar).not.toContain('? "bg-sidebar-accent font-medium');
  });
});
