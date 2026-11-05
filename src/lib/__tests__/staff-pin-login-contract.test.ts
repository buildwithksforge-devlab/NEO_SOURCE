import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

const api = readFileSync(
  "src/routes/api/public/staff-pin-login.ts",
  "utf8",
);
const client = readFileSync(
  "src/lib/staff-pin-login.ts",
  "utf8",
);

describe("trusted-device staff PIN login contract", () => {
  it("declares the correct caller for every new RPC", () => {
    expect(
      RPC_MANIFEST["neo_staff_login_device_pair"],
    ).toBe("authenticated");
    expect(
      RPC_MANIFEST["neo_staff_login_device_revoke"],
    ).toBe("authenticated");
    expect(
      RPC_MANIFEST["neo_staff_login_device_resolve"],
    ).toBe("service_role");
  });

  it("sends the device token as a bearer secret and never sends a staff code", () => {
    expect(client).toContain(
      'Authorization: `Bearer ${token}`',
    );
    expect(client).toContain("JSON.stringify({ pin })");
    expect(client).not.toMatch(/staff[_ ]code/i);
  });

  it("resolves PIN identity only through the deployed server broker", () => {
    expect(api).toContain(
      "https://horizon-prime-os.lovable.app/api/public/staff-pin-login",
    );
    expect(api).toContain(
      '"x-neo-device-token": deviceToken',
    );
    expect(api).not.toContain(
      "neo_staff_login_device_resolve",
    );
    expect(api).not.toContain(
      "@/integrations/supabase/client.server",
    );
    expect(client).not.toContain(
      "neo_staff_login_device_resolve",
    );
  });

  it("keeps privileged identity and Auth administration behind the broker", () => {
    expect(api).not.toContain(
      "supabaseAdmin",
    );
    expect(api).not.toContain(
      "getUserById",
    );
    expect(api).not.toContain(
      "generateLink",
    );
    expect(api).toMatch(
      /token_hash:\s*loginToken/,
    );
    expect(api).toMatch(
      /branch_id:\s*branchId/,
    );
    expect(api).not.toMatch(
      /return response\(\{[\s\S]*?(user_id|email)\s*:/,
    );
  });

  it("exchanges the one-time token for the employee's own session", () => {
    expect(client).toContain(
      "supabase.auth.verifyOtp",
    );
    expect(client).toContain('type: "magiclink"');
  });

  it("stores only device trust metadata and never stores a PIN", () => {
    expect(client).toContain(
      "window.localStorage.setItem(STAFF_DEVICE_TOKEN_KEY, token)",
    );
    expect(client).not.toMatch(
      /localStorage\.setItem\([^;]*pin/i,
    );
  });
});