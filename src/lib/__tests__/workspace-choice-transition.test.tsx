// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const m = vi.hoisted(() => ({
  search: { home: "1", property: "property-a" } as Record<string, string>,
  navigate: vi.fn(),
  pair: vi.fn(),
  authorise: vi.fn(),
  dashboard: vi.fn(),
  device: true,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: any) => ({ options, useSearch: () => m.search }),
  useNavigate: () => m.navigate,
  Link: ({ children, to }: any) => <a href={to}>{children}</a>,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    profile: { full_name: "Test Supervisor" },
    organizationId: "org-a",
    user: { id: "supervisor-a" },
    access: { accessScope: "group", dashboardKey: "owner" },
    canModule: () => true,
    can: () => true,
    canExact: () => true,
    phase: "ready",
    isAdmin: true,
  }),
}));
vi.mock("@/lib/branches", () => ({
  useBranchScope: () => ({
    branches: [{ id: "property-a", name: "Test Property" }],
    activeBranchId: "property-a",
    loading: false,
    setActiveBranchId: vi.fn(),
  }),
}));
vi.mock("@/lib/work-home", () => ({ resolveWorkHome: () => ({ route: "/workspace" }) }));
vi.mock("@/lib/nav-permissions", () => ({ canAccessPath: () => true }));
vi.mock("@/lib/dashboard-data", () => ({
  DEFAULT_SCOPE: {},
  useMyDashboards: () => {
    useState(0);
    m.dashboard();
    return { data: [] };
  },
  useDashboardRealtime: () => {
    useEffect(() => {}, []);
  },
}));
vi.mock("@/lib/dashboards", () => ({ dashboardSpec: () => ({}) }));
vi.mock("@/components/dashboard/DashboardFrame", () => ({
  DashboardFrame: () => <div>Main OS dashboard</div>,
}));
vi.mock("@/components/dashboard/WorkplaceSetupNotice", () => ({
  WorkplaceSetupNotice: () => null,
}));
vi.mock("@/components/hr/ClockDock", () => ({ ClockDock: () => null }));
vi.mock("@/components/layout/MobileWorkToday", () => ({ MobileWorkToday: () => null }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { signOut: vi.fn() } } }));
vi.mock("@/lib/kitchen-tickets", () => ({
  useScopedStations: () => ({
    stations: [{ id: "kitchen-a", name: "Hot Kitchen", station_type: "kitchen" }],
    isLoading: false,
    error: null,
  }),
}));
vi.mock("@/lib/shared-production-display", () => ({ pairSharedDisplay: m.pair }));
vi.mock("@/lib/staff-pin-login", () => ({
  isStaffPinSession: () => false,
  readTrustedStaffDevice: () =>
    m.device
      ? {
          deviceId: "device-a",
          branchId: "property-a",
          propertyName: "Test Property",
          label: "Staff browser",
          expiresAt: "2099-01-01T00:00:00Z",
        }
      : null,
  pairTrustedStaffDevice: m.authorise,
  revokeTrustedStaffDevice: vi.fn(),
}));
import { Route } from "@/routes/_shell.workspace";
const Page = (Route as any).options.component;
beforeEach(() => {
  vi.clearAllMocks();
  m.search = { home: "1", property: "property-a" };
  m.device = true;
});
afterEach(cleanup);
describe("property choice before entering the operating system", () => {
  it("does not load the dashboard before the operator chooses the OS and safely transitions in place", () => {
    const view = render(<Page />);
    expect(screen.getByText("Choose how you want to work")).toBeTruthy();
    expect(screen.queryByText("Main OS dashboard")).toBeNull();
    expect(m.dashboard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Enter NEØ System/ }));
    expect(m.navigate).toHaveBeenCalledWith({ href: "/workspace", replace: true });
    m.search = {};
    view.rerender(<Page />);
    expect(screen.getByText("Main OS dashboard")).toBeTruthy();
    expect(screen.queryByText("Choose how you want to work")).toBeNull();
  });
  it("acknowledges a matching authorised device and cannot pair it again from the disabled control", () => {
    render(<Page />);
    const button = screen.getByRole("button", { name: "Device authorised" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(m.authorise).not.toHaveBeenCalled();
  });
  it("keeps a different property out of the chosen context", () => {
    m.search = { home: "1", property: "other-property" };
    render(<Page />);
    expect(
      screen.getByText("This property is not available within your current staff access."),
    ).toBeTruthy();
    expect(screen.queryByText("Main OS dashboard")).toBeNull();
    expect(m.pair).not.toHaveBeenCalled();
  });
  it("opens station setup without entering the main dashboard", () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: /Set up Kitchen Display/ }));
    expect(screen.getByText("Configure Kitchen Display")).toBeTruthy();
    expect(m.dashboard).not.toHaveBeenCalled();
    expect(m.navigate).not.toHaveBeenCalled();
  });
});
