// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
const access = vi.hoisted(() => ({ loaded: true, allowed: false, present: true }));
vi.mock("@/lib/auth", () => ({ useOptionalAuth: () => access.present
  ? { permissionsLoaded: access.loaded, can: () => access.allowed } : null }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ to, children, ...props }: { to: string; children: ReactNode }) =>
  <a href={to} {...props}>{children}</a> }));
import { StatCard } from "@/components/common/DataDisplay";
import { capabilityForPath, pathPermitted } from "@/lib/capabilities";
afterEach(cleanup);
beforeEach(() => { access.loaded = true; access.allowed = false; access.present = true; });

describe("metric links follow page authority", () => {
  it("retains an allowed summary without advertising a denied destination", () => {
    render(<StatCard label="Arrivals" value="4" to="/pms/arrivals" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Open")).toBeNull();
    expect(screen.getByText("4")).toBeTruthy();
  });
  it("does not flash a protected link before permissions load", () => {
    access.loaded = false; access.allowed = true;
    render(<StatCard label="Arrivals" value="4" to="/pms/arrivals" />);
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("keeps the permitted destination available", () => {
    access.allowed = true;
    render(<StatCard label="Arrivals" value="4" to="/pms/arrivals" />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/pms/arrivals");
  });
  it("preserves in-page filters independently of navigation", () => {
    const click = vi.fn();
    render(<StatCard label="Arrivals" value="4" onClick={click} />);
    fireEvent.click(screen.getByRole("button"));
    expect(click).toHaveBeenCalledOnce();
  });
  it("preserves links on public surfaces without a staff auth provider", () => {
    access.present = false;
    render(<StatCard label="Stays" value="4" to="/stays" />);
    expect(screen.getByRole("link")).toBeTruthy();
  });
});

describe("reservation creation has its own route authority", () => {
  it("never opens the creation route from a read-only reservation grant", () => {
    const readOnly = (module: string, feature: string, action?: string) => module === "front-office"
      && feature === "reservations" && action === "view";
    expect(pathPermitted(readOnly, "/pms/reservations")).toBe(true);
    expect(pathPermitted(readOnly, "/pms/reservations/new")).toBe(false);
    expect(capabilityForPath("/pms/reservations/new")?.action).toBe("create");
  });
});
