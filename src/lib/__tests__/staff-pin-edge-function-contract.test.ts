import {
  describe,
  expect,
  it,
} from "vitest";
import {
  readFileSync,
} from "node:fs";
import {
  resolve,
} from "node:path";

const route = readFileSync(
  resolve(
    "src/routes/api/public/staff-pin-login.ts",
  ),
  "utf8",
);

const edgeFunction = readFileSync(
  resolve(
    "supabase/functions/neo-staff-pin-login/index.ts",
  ),
  "utf8",
);

const config = readFileSync(
  resolve("supabase/config.toml"),
  "utf8",
);

describe("Staff PIN Edge Function bridge", () => {
  it("moves privileged authentication into the backend function", () => {
    expect(route).toContain(
      "/functions/v1/neo-staff-pin-login",
    );

    expect(route).not.toContain(
      "supabaseAdmin.auth.admin",
    );

    expect(edgeFunction).toContain(
      'Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")',
    );

    expect(edgeFunction).toContain(
      '"neo_staff_login_device_resolve"',
    );
  });

  it("preserves the browser login contract", () => {
    expect(edgeFunction).toMatch(
      /token_hash:\s*loginToken/,
    );

    expect(edgeFunction).toMatch(
      /branch_id:\s*branchId/,
    );

    expect(route).toMatch(
      /token_hash:\s*loginToken/,
    );

    expect(route).toMatch(
      /branch_id:\s*branchId/,
    );
  });

  it("allows the trusted device token instead of requiring a user JWT", () => {
    expect(config).toMatch(
      /\[functions\.neo-staff-pin-login\][\s\S]*verify_jwt\s*=\s*false/,
    );

    expect(edgeFunction).toContain(
      '"x-neo-device-token"',
    );
  });
});
