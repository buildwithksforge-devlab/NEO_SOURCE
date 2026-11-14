import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const auth = readFileSync("src/routes/auth.tsx", "utf8");
const pinForm = readFileSync(
  "src/components/auth/StaffPinSignIn.tsx",
  "utf8",
);
const workspace = readFileSync(
  "src/routes/_shell.workspace.tsx",
  "utf8",
);

describe("staff PIN login user interface", () => {
  it("offers Staff PIN as an explicit login-page option", () => {
    expect(auth).toContain('["pin", "Staff PIN"]');
    expect(auth).toContain("<StaffPinSignIn />");
    expect(auth).toContain('search["mode"] === "pin"');
  });

  it("requires an authorised property device before accepting a PIN", () => {
    expect(pinForm).toContain("readTrustedStaffDevice()");
    expect(pinForm).toContain(
      "This device is not yet authorised",
    );
    expect(pinForm).toContain("signInWithStaffPin(pin)");
  });

  it("uses a PIN-only keypad and never requests a staff code", () => {
    expect(pinForm).toContain('aria-label="PIN keypad"');
    expect(pinForm).toContain("Personal six-digit PIN");
    expect(pinForm).not.toMatch(/staff[_ ]code/i);
  });

  it("returns successful PIN login to the trusted property entrance", () => {
    expect(pinForm).toContain(
      "/workspace?home=1&property=",
    );
  });

  it("shows device authorisation only to workforce-authorised staff", () => {
    expect(workspace).toContain(
      'can("administration", "users", "manage")',
    );
    expect(workspace).toContain(
      'can("administration", "users", "invite")',
    );
    expect(workspace).toContain(
      'can("administration", "users", "assign_roles")',
    );
    expect(workspace).toContain(
      "{canAuthorizeDevice ? (",
    );
  });

  it("pairs the selected property and signs the administrator out", () => {
    expect(workspace).toContain(
      "pairTrustedStaffDevice(",
    );
    expect(workspace).toContain(
      'supabase.auth.signOut({',
    );
    expect(workspace).toContain(
      'window.location.replace("/auth?mode=pin")',
    );
  });
});