// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
const route = vi.hoisted(() => ({href: "https://neo-preview.neo-hospitality.workers.dev/workspace/?home=1&property=property-a"}));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: (options: any) =>
    options.select({
      location: {
        href: route.href,
      },
    }),
  Outlet: () => <div>Property work choices</div>,
}));
vi.mock("@/components/layout/WorkspaceBootGate", () => ({
  WorkspaceBootGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/layout/Sidebar", () => ({
  SidebarContent: () => <aside>OS sidebar</aside>,
  MobileSidebar: () => null,
}));
vi.mock("@/components/layout/Topbar", () => ({ Topbar: () => <header>OS topbar</header> }));
vi.mock("@/components/common/BackNavigation", () => ({
  BackNavigation: () => <button>Back</button>,
}));
vi.mock("@/components/app/AppInstallation", () => ({ AppInstallButton: () => null }));
vi.mock("@/components/brand/NeoGlyph", () => ({ CreatorCredit: () => <span>Credit</span> }));
vi.mock("@/components/brand/NeoIdentity", () => ({
  PoweredByNeoSignature: () => <span>NEØ</span>,
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: null, roleNames: [] }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
import { AppShell } from "@/components/layout/AppShell";
afterEach(cleanup);
describe("actual property entrance frame", () => {
  it("renders the chooser outside OS navigation for absolute/trailing-slash entrance URLs", () => {
    const view = render(<AppShell />);
    expect(view.container.querySelector("[data-neo-workspace-entrance-frame]")).toBeTruthy();
    expect(view.container.querySelector("[data-shell-sidebar]")).toBeNull();
    expect(screen.getByText("Property work choices")).toBeTruthy();
    expect(screen.queryByText("OS sidebar")).toBeNull();
    expect(screen.queryByText("OS topbar")).toBeNull();
  });
  it("renders the observed JSON-quoted entrance outside dashboard chrome", () => {
    route.href = "https://neo-preview.neo-hospitality.workers.dev/workspace?home=%221%22&property=property-a";
    const view = render(<AppShell />);
    expect(view.container.querySelector("[data-neo-workspace-entrance-frame]")).toBeTruthy();
    expect(screen.queryByText("OS sidebar")).toBeNull();
    expect(screen.queryByText("OS topbar")).toBeNull();
    route.href = "https://neo-preview.neo-hospitality.workers.dev/workspace/?home=1&property=property-a";
  });
});
