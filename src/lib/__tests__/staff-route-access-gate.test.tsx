// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RouteAccessGate } from "@/components/layout/RouteAccessGate";

const state = vi.hoisted(() => ({
  path: "/pos/settings",
  permissionsLoaded: false,
  can: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => state.path }));
vi.mock("@/lib/auth", () => ({ useAuth: () => state }));
vi.mock("@/components/common/AccessState", () => ({
  AccessDeniedPanel: ({ subject }: { subject: string }) => <p>Access denied for {subject}</p>,
}));
vi.mock("@/components/common/StateSystem", () => ({
  LoadingState: () => <p>Loading permissions</p>,
}));
afterEach(() => {
  cleanup();
  state.can.mockReset();
});

it("does not mount a protected page while checking grants or when its grant is missing", () => {
  state.path = "/PoS/Settings/";
  state.permissionsLoaded = false;
  const page = <RouteAccessGate><p>POS settings content</p></RouteAccessGate>;
  const view = render(page);
  expect(screen.getByText("Loading permissions")).toBeTruthy();
  expect(screen.queryByText("POS settings content")).toBeNull();
  expect(state.can).not.toHaveBeenCalled();

  state.permissionsLoaded = true;
  state.can.mockReturnValue(false);
  view.rerender(<RouteAccessGate><p>POS settings content</p></RouteAccessGate>);
  expect(screen.getByText(/Access denied/)).toBeTruthy();
  expect(screen.queryByText("POS settings content")).toBeNull();
  expect(state.can).toHaveBeenCalledWith("restaurant", "settings", "edit");

  state.can.mockReturnValue(true);
  view.rerender(<RouteAccessGate><p>POS settings content</p></RouteAccessGate>);
  expect(screen.getByText("POS settings content")).toBeTruthy();
});
