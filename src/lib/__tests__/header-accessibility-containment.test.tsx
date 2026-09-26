// @vitest-environment jsdom
/**
 * Shared staff top header — keyboard access, containment and clock format.
 *
 * Three promises are pinned here:
 *   1. Every header utility is reachable and operable from the keyboard, with
 *      a spoken name — including the ones that collapse into "More" on small
 *      screens, which must move rather than disappear.
 *   2. At 360px, 430px and 1024px nothing escapes the header row. jsdom has no
 *      layout engine, so containment is asserted structurally: the row clips,
 *      every flexible track can shrink, and long identity text is clamped to
 *      one line instead of pushing the row wider.
 *   3. The date/time keeps its exact compact formatting — `THU 27 AUG '26`
 *      and `12:03 PM`, uppercase, two-digit year, no seconds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const theme = { value: "light" as "light" | "dark", toggle: vi.fn() };

vi.mock("@tanstack/react-router", async () => {
  const React = await import("react");
  return {
    Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) =>
      React.createElement("a", { href: to, ...rest }, children),
    useRouterState: () => "/delivery/reports",
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: 128 }),
  // The header now carries the workspace selector, which reads the query
  // client to clear cached data when a workspace changes.
  useQueryClient: () => ({ clear: () => {}, invalidateQueries: () => {} }),
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
}));


vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    profile: {
      full_name: "Wanjiru Kamau-Otieno",
      email: "wanjiru.kamau-otieno@coastlinecollection.co.ke",
      avatar_url: null,
      account_status: "active",
    },
    organizationId: "org-1",
    roleNames: ["Front Office & Reservations Manager"],
    signOut: vi.fn(),
    isAdmin: true,
  }),
}));

// This suite exercises header containment and keyboard reach, so the reader is
// given full page visibility; permission gating is covered by its own tests.
vi.mock("@/lib/visibility", () => ({
  useVisibility: () => ({ canSeePage: () => true }),
}));

vi.mock("@/lib/branding", () => ({
  useBranding: () => ({ theme: theme.value, toggleTheme: theme.toggle }),
}));

vi.mock("@/lib/branches", () => ({
  useBranchScope: () => ({
    activeBranch: { id: "prop-1", name: "Coastline Diani Beach Resort & Spa" },
    canManage: true,
    branches: [{ id: "prop-1", name: "Coastline Diani Beach Resort & Spa" }],
  }),
  useActiveTimezone: () => "Africa/Nairobi",
}));

vi.mock("@/lib/branch-filter", () => ({
  useActivePropertyFilter: () => ({ applyTo: (q: unknown) => q, filterKey: "prop-1" }),
}));

vi.mock("@/lib/tenant", () => ({
  useTenant: () => ({ tenant: { organization: { name: "Coastline Collection" } } }),
}));

vi.mock("@/components/layout/PropertySelector", () => ({
  PropertySelector: ({ className }: { className?: string }) => (
    <button type="button" className={className} aria-label="Active property">
      Coastline Diani Beach Resort &amp; Spa
    </button>
  ),
}));

vi.mock("@/components/common/ReportProblemDialog", () => ({
  ReportProblemDialog: () => (
    <button type="button" aria-label="Report a problem">
      Report a problem
    </button>
  ),
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: () => ({}) } }));
vi.mock("@/lib/query-telemetry", () => ({ reportQueryError: vi.fn() }));

const { Topbar } = await import("@/components/layout/Topbar");
const { clockParts } = await import("@/components/layout/LiveClock");

const WIDTHS = [360, 430, 1024];

const renderAt = (width: number) => {
  window.innerWidth = width;
  return render(
    <div style={{ width }}>
      <Topbar onOpenSidebar={vi.fn()} />
    </div>,
  );
};

beforeEach(() => {
  theme.value = "light";
  theme.toggle.mockClear();
});

afterEach(cleanup);

describe("header utilities are keyboard accessible", () => {
  it("every interactive control has a spoken name and is tabbable", () => {
    const { container } = renderAt(1024);
    const controls = Array.from(
      container.querySelectorAll<HTMLElement>("button, a[href]"),
    );
    expect(controls.length).toBeGreaterThan(6);

    for (const el of controls) {
      const name =
        el.getAttribute("aria-label") ??
        el.querySelector(".sr-only")?.textContent ??
        el.textContent ??
        "";
      expect(name.trim(), `${el.outerHTML.slice(0, 90)} must be announced`).not.toBe("");
      // Nothing is removed from the tab ring or hidden from assistive tech.
      expect(el.getAttribute("tabindex")).not.toBe("-1");
      expect(el.closest("[aria-hidden='true']")).toBeNull();
    }
  });

  it("tabbing reaches the overflow and profile menus without a mouse", async () => {
    renderAt(360);
    const user = userEvent.setup();

    const reached: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      await user.tab();
      const active = document.activeElement as HTMLElement | null;
      if (!active) continue;
      const label = active.getAttribute("aria-label") ?? "";
      if (label) reached.push(label);
      if (active.hasAttribute("data-profile-trigger")) reached.push("profile");
    }

    expect(reached).toContain("More actions");
    expect(reached).toContain("profile");
  }, 20_000);

  it("the collapsed utilities open with Enter and close with Escape", async () => {
    renderAt(360);
    const user = userEvent.setup();

    const more = screen.getByRole("button", { name: "More actions" });
    more.focus();
    await user.keyboard("{Enter}");

    const menu = await screen.findByRole("menu", {}, { timeout: 8000 });
    // Nothing is dropped on a phone — it moves into the overflow menu.
    expect(within(menu).getByText("Tasks")).toBeTruthy();
    expect(within(menu).getByText("Approvals")).toBeTruthy();
    expect(within(menu).getByText(/toggle theme/i)).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(more);
  });

  it("the profile menu opens from the keyboard and offers sign out", async () => {
    const { container } = renderAt(430);
    const user = userEvent.setup();

    const trigger = container.querySelector<HTMLElement>("[data-profile-trigger]")!;
    trigger.focus();
    await user.keyboard("{Enter}");

    const menu = await screen.findByRole("menu", {}, { timeout: 8000 });
    expect(within(menu).getByText(/sign out/i)).toBeTruthy();
    // The property selector follows into the menu where the row cannot hold it.
    expect(within(menu).getByRole("button", { name: "Active property" })).toBeTruthy();
  }, 20_000);
});

describe.each(WIDTHS)("no overflow or clipping at %ipx", (width) => {
  it("the header row clips and every track can shrink", () => {
    const { container } = renderAt(width);
    const row = container.querySelector<HTMLElement>("header > div")!;

    expect(row.className).toMatch(/overflow-hidden/);
    // neo-shell-bleed carries width:100%/max-width:100%/min-width:0.
    expect(row.className).toMatch(/neo-shell-bleed/);
    expect(row.className).toMatch(/neo-page-gutter/);
    // The action cluster is pinned right and never widens the row.
    const cluster = container.querySelector<HTMLElement>("[data-action-cluster]")!;
    expect(cluster.className).toMatch(/ml-auto/);
    expect(cluster.className).toMatch(/shrink-0/);
  });

  it("long identity text is clamped to one line instead of pushing the row", () => {
    const { container } = renderAt(width);

    // The module name is permanent identity: visible at every width, sized
    // fluidly by neo-module-label, clipped to one line only as a last resort.
    const moduleLabel = container.querySelector<HTMLElement>("[data-module-label]")!;
    expect(moduleLabel.className).toMatch(/neo-module-label/);
    expect(moduleLabel.className).not.toMatch(/\bhidden\b/);
    expect(moduleLabel.textContent?.trim()).toBe("Delivery");

    const profile = container.querySelector<HTMLElement>("[data-profile-trigger]")!;
    expect(profile.className).toMatch(/max-w-\[13rem\]/);
    expect(profile.className).toMatch(/shrink-0/);
    for (const span of Array.from(profile.querySelectorAll("span span"))) {
      expect(span.className).toMatch(/truncate/);
    }
  });

  it("phone widths collapse low-priority utilities rather than overflowing", () => {
    const { container } = renderAt(width);
    const overflow = container.querySelector<HTMLElement>("[data-header-overflow]")!;
    // Present on phone/tablet, hidden once the row has room for the utilities.
    expect(overflow.className).toMatch(/lg:hidden/);
  });
});

describe("compact date and time formatting is preserved", () => {
  const zone = "Africa/Nairobi";

  it("renders `THU 27 AUG '26` and `12:03 PM` exactly", () => {
    const parts = clockParts(new Date("2026-08-27T09:03:00Z"), zone);
    expect(parts.date).toBe("THU 27 AUG '26");
    expect(parts.time).toBe("12:03 PM");
  });

  it("never shows seconds and always uses a two-digit year", () => {
    for (const iso of ["2026-01-05T04:07:41Z", "2026-12-31T18:59:59Z"]) {
      const parts = clockParts(new Date(iso), zone);
      expect(parts.date).toMatch(/^[A-Z]{3} \d{2} [A-Z]{3} '\d{2}$/);
      expect(parts.time).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    }
  });

  it("keeps the clock on one line and out of the shrinking path", () => {
    const { container } = renderAt(1024);
    const clock = container.querySelector<HTMLElement>("[data-live-clock]");
    // Rendered client-side after mount; the placeholder must be inert.
    const node = clock ?? container.querySelector<HTMLElement>("[aria-hidden]")!;
    expect(node.className).toMatch(/min-w-0/);
  });
});
