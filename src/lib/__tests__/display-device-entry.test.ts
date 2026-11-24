import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("standalone production display entry", () => {
  it("renders the property work chooser without operating-system chrome", () => {
    const shell = read("src/components/layout/AppShell.tsx");

    expect(shell).toContain("data-neo-workspace-entrance-frame");
    expect(shell).toContain("entranceMode");
    expect(shell).toContain("<WorkspaceEntranceLayout />");
  });

  it("pairs a station-restricted display from the property entrance", () => {
    const workspace = read("src/routes/_shell.workspace.tsx");

    expect(workspace).toContain("useScopedStations()");
    expect(workspace).toContain("displayStations(");
    expect(workspace).toContain("pairSharedDisplay(");
    expect(workspace).toContain("data-neo-display-device-setup");
    expect(workspace).toContain("Pair and open display");
    expect(workspace).toContain("canPairDisplay");
  });

  it("removes duplicate operational display navigation", () => {
    const navigation = read("src/lib/navigation.ts");
    const controls = read(
      "src/routes/_shell.production-displays.tsx",
    );

    expect(navigation).not.toContain('to: "/bar/display"');
    expect(navigation).not.toContain('to: "/kitchen/display"');
    expect(navigation).not.toContain('to: "/coffee/display"');
    expect(navigation).not.toContain('to: "/pastry/display"');
    expect(navigation).not.toContain('to: "/pos/kds"');
    expect(navigation).toContain('to: "/production-displays"');

    expect(controls).toContain("Set up a new display");
    expect(controls).not.toContain("Object.entries(DISPLAY_ROUTES)");
  });

  it("keeps the device screen outside employee authentication", () => {
    const screen = read("src/routes/station-screen.tsx");

    expect(screen).toContain('createFileRoute("/station-screen")');
    expect(screen).toContain("ensureSharedScreenSignedOut");
    expect(screen).toContain("readSharedDisplayToken()");
  });
});