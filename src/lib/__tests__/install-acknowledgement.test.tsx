// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppInstallationProvider, AppInstallButton } from "@/components/app/AppInstallation";
import {
  INSTALL_ACK_KEY,
  INSTALL_DISMISSED_KEY,
  hasConfiguredDisplayOrStaffDevice,
} from "@/lib/install-preferences";
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ loading: false }) }));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: (options: any) =>
    options.select({ status: "idle", location: { pathname: "/auth" } }),
}));
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function show() {
  return render(
    <AppInstallationProvider>
      <AppInstallButton />
    </AppInstallationProvider>,
  );
}
describe("durable installation and device acknowledgements", () => {
  it("remembers dismissal after sign-out clears session storage and the provider remounts", () => {
    const first = show();
    act(() => vi.advanceTimersByTime(2200));
    fireEvent.click(screen.getByRole("button", { name: "Continue in browser" }));
    expect(localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe("1");
    first.unmount();
    sessionStorage.clear();
    show();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Install app" })).toBeTruthy();
  });
  it("remembers a real installation event across a later browser session", () => {
    const first = show();
    act(() => window.dispatchEvent(new Event("appinstalled")));
    expect(localStorage.getItem(INSTALL_ACK_KEY)).toBe("1");
    first.unmount();
    sessionStorage.clear();
    show();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Install app" })).toBeNull();
  });
  it("lets users acknowledge an existing installation without claiming a new browser installation event", () => {
    show();
    act(() => vi.advanceTimersByTime(2200));
    fireEvent.click(screen.getByRole("button", { name: "Already installed" }));
    expect(localStorage.getItem(INSTALL_ACK_KEY)).toBe("1");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Install app" })).toBeNull();
  });
  it("does not nag a browser with existing unexpired staff-device authorisation", () => {
    localStorage.setItem("neo.staffPinDevice.token", "recognised-device");
    localStorage.setItem(
      "neo.staffPinDevice.meta",
      JSON.stringify({
        branchId: "property-a",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    show();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Install app" })).toBeNull();
  });
  it("does not restart install reminders when previously recognised device access expires", () => {
    localStorage.setItem("neo.staffPinDevice.token", "recognised-device");
    localStorage.setItem("neo.staffPinDevice.meta", JSON.stringify({branchId:"property-a",expiresAt:new Date(Date.now()+3600000).toISOString()}));
    const first=show();
    expect(localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe("1");
    first.unmount();sessionStorage.clear();
    localStorage.setItem("neo.staffPinDevice.meta", JSON.stringify({branchId:"property-a",expiresAt:"2000-01-01T00:00:00Z"}));
    show();act(()=>vi.advanceTimersByTime(5000));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("does not mistake expired device metadata for a current acknowledgement", () => {
    localStorage.setItem("neo.staffPinDevice.token", "old");
    localStorage.setItem(
      "neo.staffPinDevice.meta",
      JSON.stringify({ branchId: "property-a", expiresAt: "2000-01-01T00:00:00Z" }),
    );
    expect(hasConfiguredDisplayOrStaffDevice()).toBe(false);
    show();
    act(() => vi.advanceTimersByTime(2200));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
