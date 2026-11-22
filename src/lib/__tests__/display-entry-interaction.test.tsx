// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SharedDisplayTools } from "@/components/kitchen/SharedDisplayTools";
import { isWorkspaceEntrance } from "@/lib/workspace-entrance";
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, search, ...props }: any) => (
    <a href={`${to}?redirect=${encodeURIComponent(search?.redirect ?? "")}`} {...props}>
      {children}
    </a>
  ),
}));
afterEach(cleanup);
describe("property work entrance layout", () => {
  it.each([
    "/workspace?home=1&property=property-a",
    "/workspace/?home=1",
    "https://neo-preview.neo-hospitality.workers.dev/workspace?home=1",
    "/workspace?home=1#choice",
    "/workspace?home=%221%22&property=property-a",
    'https://neo-preview.neo-hospitality.workers.dev/workspace/?home="1"',
  ])("keeps %s outside dashboard chrome", (href) => expect(isWorkspaceEntrance(href)).toBe(true));
  it.each([
    "/workspace",
    "/workspace?home=0",
    "/workspace?home=%220%22",
    "/workspace?home=%22true%22",
    "/workspace-other?home=1",
    "/kitchen/display?home=1",
  ])("keeps %s in its appropriate route frame", (href) =>
    expect(isWorkspaceEntrance(href)).toBe(false),
  );
});
describe("restricted display tools", () => {
  const station = vi.fn(),
    compact = vi.fn(),
    logout = vi.fn(),
    approve = vi.fn();
  beforeEach(() => { vi.clearAllMocks(); approve.mockResolvedValue(undefined); });
  async function unlock(button: string) {
    fireEvent.click(screen.getByRole("button", { name: button }));
    fireEvent.change(screen.getByLabelText("Personal PIN"), { target: { value: "246810" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  }
  function show() {
    return render(
      <SharedDisplayTools
        stations={[
          { id: "kitchen-a", name: "Hot Kitchen" },
          { id: "pastry-a", name: "Pastry" },
        ]}
        station="all"
        onStationChange={station}
        compact={false}
        onCompactChange={compact}
        onApprove={approve}
        onLogout={logout}
      />,
    );
  }
  it("opens and returns from tools without logging out or changing pairing", async () => {
    show();
    await unlock("Supervisor tools");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(logout).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Return to display" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(logout).not.toHaveBeenCalled();
  });
  it("filters only the already paired station choices and exposes real spacing control", async () => {
    show();
    await unlock("Supervisor tools");
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "All paired stations",
      "Hot Kitchen",
      "Pastry",
    ]);
    fireEvent.change(screen.getByLabelText("Stations shown"), { target: { value: "pastry-a" } });
    expect(station).toHaveBeenCalledWith("pastry-a");
    fireEvent.click(screen.getByRole("switch", { name: "Compact spacing" }));
    expect(compact).toHaveBeenCalledWith(true);
    expect(logout).not.toHaveBeenCalled();
  });
  it("requires an explicit sign-in link to change paired scope", async () => {
    show();
    await unlock("Supervisor tools");
    expect(
      (await screen.findByRole("link", { name: "Change paired display / access" })).getAttribute("href"),
    ).toContain("/auth?redirect=%2Fproduction-displays");
    expect(logout).not.toHaveBeenCalled();
  });
  it("keeps the display open on a rejected personal PIN and logs out after approval", async () => {
    show();
    approve.mockRejectedValueOnce(new Error("Supervisor approval was refused"));
    await unlock("Log out of display");
    expect((await screen.findByRole("alert")).textContent).toContain("Supervisor approval was refused");
    expect(logout).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Personal PIN"), { target: { value: "135790" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(approve).toHaveBeenLastCalledWith("135790", "logout");
  });
});
