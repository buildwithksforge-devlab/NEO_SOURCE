// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import {
  useGuestDisplayPrefs,
  GUEST_DISPLAY_KEY,
  parseGuestDisplay,
} from "@/lib/guest-display-preferences";
import { GuestScreen } from "@/components/public/GuestScreen";
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...p }: any) => <a {...p}>{children}</a>,
  useRouterState: () => "/guest/demo",
}));
vi.mock("@/components/public/PublicAppShell", () => ({
  useWorkspace: () => ({
    hotel_name: "Demo",
    app_name: "Demo",
    primary_color: "#BFDADD",
    background_color: "#F7F9FC",
    secondary_color: "#07142D",
    button_style: "rounded",
  }),
}));
vi.mock("@/components/public/GuestHeader", () => ({
  GuestHeader: () => null,
  GuestFooter: () => null,
}));
vi.mock("@/components/common/PullToRefresh", () => ({
  PullToRefresh: ({ children }: any) => <>{children}</>,
}));
vi.mock("@/components/public/PreviewBanner", () => ({ PreviewBanner: () => null }));
vi.mock("@/lib/brand-cache", () => ({ writeLaunchLockup: vi.fn() }));
function Controls() {
  const { prefs, setPref } = useGuestDisplayPrefs();
  return (
    <>
      <button onClick={() => setPref("appearance", "dark")}>Dark</button>
      <button onClick={() => setPref("appearance", "light")}>Light</button>
      <button onClick={() => setPref("largerText", true)}>Larger</button>
      <button onClick={() => setPref("reducedMotion", true)}>Less motion</button>
      <button onClick={() => setPref("highContrast", true)}>Contrast</button>
      <output>{prefs.appearance}</output>
    </>
  );
}
function Page() {
  return (
    <>
      <Controls />
      <GuestScreen hotelSlug="demo" active="home">
        <p>Guest content</p>
      </GuestScreen>
    </>
  );
}
afterEach(cleanup);
beforeEach(() => window.localStorage.clear());
describe("guest device preferences reach the actual shared screen", () => {
  it("applies appearance immediately across hook subscribers and persists it", async () => {
    const { container } = render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: /^Dark$/ }));
    await waitFor(() =>
      expect(container.querySelector(".neo-guest-app")?.getAttribute("data-guest-appearance")).toBe(
        "dark",
      ),
    );
    expect(JSON.parse(localStorage.getItem(GUEST_DISPLAY_KEY)!).appearance).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: /^Light$/ }));
    expect(container.querySelector(".neo-guest-app")?.getAttribute("data-guest-appearance")).toBe(
      "light",
    );
  });
  it("restores the device choice on a later screen mount", async () => {
    localStorage.setItem(
      GUEST_DISPLAY_KEY,
      JSON.stringify({ appearance: "dark", largerText: true }),
    );
    const { container } = render(<Page />);
    await waitFor(() =>
      expect(container.querySelector(".neo-guest-app")?.getAttribute("data-guest-appearance")).toBe(
        "dark",
      ),
    );
    expect(container.querySelector(".neo-guest-app")?.getAttribute("data-larger-text")).toBe(
      "true",
    );
  });
  it("connects all accessibility settings without losing earlier choices", () => {
    const { container } = render(<Page />);
    for (const name of ["Larger", "Less motion", "Contrast"])
      fireEvent.click(screen.getByRole("button", { name: new RegExp("^" + name + "$") }));
    const root = container.querySelector(".neo-guest-app");
    for (const key of ["data-larger-text", "data-reduced-motion", "data-high-contrast"])
      expect(root?.getAttribute(key)).toBe("true");
  });
  it("rejects malformed stored preference types", () =>
    expect(
      parseGuestDisplay({ appearance: "other", reducedMotion: "true", largerText: 1 }),
    ).toEqual({
      appearance: "system",
      reducedMotion: false,
      largerText: false,
      highContrast: false,
    }));
});
