import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";
import { Route } from "@/routes/api/public/staff-pin-login";

const api = readFileSync("src/routes/api/public/staff-pin-login.ts", "utf8");
const client = readFileSync("src/lib/staff-pin-login.ts", "utf8");

describe("trusted-device staff PIN login contract", () => {
  it("declares the correct caller for every new RPC", () => {
    expect(RPC_MANIFEST["neo_staff_login_device_pair"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_staff_login_device_revoke"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_staff_login_device_resolve"]).toBe("service_role");
  });

  it("sends the device token as a bearer secret and never sends a staff code", () => {
    expect(client).toContain("Authorization: `Bearer ${token}`");
    expect(client).toContain("JSON.stringify({ pin })");
    expect(client).not.toMatch(/staff[_ ]code/i);
  });

  it("resolves PIN identity only through the deployed server broker", () => {
    expect(api).toContain("https://horizon-prime-os.lovable.app/api/public/staff-pin-login");
    expect(api).toContain('"x-neo-device-token": deviceToken');
    expect(api).not.toContain("neo_staff_login_device_resolve");
    expect(api).not.toContain("@/integrations/supabase/client.server");
    expect(client).not.toContain("neo_staff_login_device_resolve");
  });

  it("keeps privileged identity and Auth administration behind the broker", () => {
    expect(api).not.toContain("supabaseAdmin");
    expect(api).not.toContain("getUserById");
    expect(api).not.toContain("generateLink");
    expect(api).toMatch(/token_hash:\s*loginToken/);
    expect(api).toMatch(/branch_id:\s*branchId/);
    expect(api).not.toMatch(/return response\(\{[\s\S]*?(user_id|email)\s*:/);
  });

  it("exchanges the one-time token for the employee's own session", () => {
    expect(client).toContain("supabase.auth.verifyOtp");
    expect(client).toContain('type: "magiclink"');
  });

  it("stores only device trust metadata and never stores a PIN", () => {
    expect(client).toContain("window.localStorage.setItem(STAFF_DEVICE_TOKEN_KEY, token)");
    expect(client).not.toMatch(/localStorage\.setItem\([^;]*pin/i);
  });
});

describe("staff PIN broker request/response behavior", () => {
  const token = `neowd_${"a".repeat(64)}`;
  const branch = "00000000-0000-4000-8000-000000000001";
  type Handler = (input: { request: Request }) => Promise<Response>;
  const handler = (Route.options as unknown as { server: { handlers: { POST: Handler } } }).server
    .handlers.POST;
  const request = (pin = "123456", bearer = token) =>
    new Request("https://neo-preview.neo-hospitality.workers.dev/api/public/staff-pin-login", {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
  afterEach(() => vi.unstubAllGlobals());

  it("rejects missing device trust and malformed PINs before contacting a broker", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await handler({ request: request("123456", "invalid") })).status).toBe(401);
    expect((await handler({ request: request("12345") })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("carries only the scoped device proof and PIN to the fixed broker without following redirects", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        token_hash: "synthetic-one-time-token",
        branch_id: branch,
        email: "must-not-be-returned",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const response = await handler({ request: request() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token_hash: "synthetic-one-time-token",
      branch_id: branch,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://horizon-prime-os.lovable.app/api/public/staff-pin-login");
    expect(init.headers["x-neo-device-token"]).toBe(token);
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toEqual({ pin: "123456" });
  });
  it("preserves rejected credentials from the original broker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: "credentials",
            message: "PIN not accepted",
          },
          { status: 401 },
        ),
      ),
    );
    const response = await handler({ request: request() });
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("credentials");
  });
  it("refuses a successful HTTP response without a valid login-token/property contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true })));
    expect((await handler({ request: request() })).status).toBe(502);
  });
  it("does not retry a failed broker connection", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("Connection failed"));
    vi.stubGlobal("fetch", fetch);
    expect((await handler({ request: request() })).status).toBe(502);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
