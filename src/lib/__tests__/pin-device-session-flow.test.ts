import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("coordinated PIN device session flow", () => {
  it("marks personal PIN sessions and clears the marker for account login", () => {
    const staffLogin = read("src/lib/staff-pin-login.ts");
    const auth = read("src/routes/auth.tsx");

    expect(staffLogin).toContain("markStaffPinSession();");
    expect(staffLogin).toContain("STAFF_PIN_SESSION_KEY");
    expect(auth).toContain("clearStaffPinSession();");
  });

  it("routes PIN staff directly through their permission-resolved work home", () => {
    const workspace = read("src/routes/_shell.workspace.tsx");

    expect(workspace).toContain("isStaffPinSession()");
    expect(workspace).toContain("pinHomeTarget");
    expect(workspace).toContain("workHome.route");
  });

  it("returns a locked shared terminal to staff PIN entry", () => {
    const auth = read("src/lib/auth.tsx");
    const exit = read("src/lib/session-exit.ts");

    expect(auth).toContain('"/auth?mode=pin"');
    expect(auth).toContain("isStaffPinSession()");
    expect(exit).toContain('"/auth?mode=pin"');
  });

  it("persists only the restricted production-display credential", () => {
    const shared = read("src/lib/shared-production-display.ts");
    const screen = read("src/routes/station-screen.tsx");

    expect(shared).toContain(
      "window.localStorage.setItem(",
    );
    expect(shared).not.toContain(
      "sessionStorage.setItem(DISPLAY_TOKEN_STORAGE_KEY",
    );
    expect(screen).toContain("readSharedDisplayToken()");
  });

  it("does not advertise production displays on unpaired browsers", () => {
    const auth = read("src/routes/auth.tsx");

    expect(auth).toContain("{pairedDisplayToken ? (");
    expect(auth).toContain("Resume Paired Production Display");
  });
});