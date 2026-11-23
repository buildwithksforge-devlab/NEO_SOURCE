import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";
import { Route } from "@/routes/api/public/staff-pin-login";
import { signInWithStaffPin, STAFF_DEVICE_TOKEN_KEY, STAFF_PIN_SESSION_KEY } from "@/lib/staff-pin-login";
import { DISPLAY_TOKEN_STORAGE_KEY } from "@/lib/shared-production-display";
import { createClient } from "@supabase/supabase-js";

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  verifyOtp: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));
const admin = vi.hoisted(() => ({
  rpc: vi.fn(),
  auth: { admin: { getUserById: vi.fn(), generateLink: vi.fn() } },
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => admin) }));

const api = readFileSync("src/routes/api/public/staff-pin-login.ts", "utf8");
const client = readFileSync("src/lib/staff-pin-login.ts", "utf8");

describe("trusted-device staff PIN login contract", () => {
  it("declares the correct caller for every new RPC", () => {
    expect(RPC_MANIFEST["neo_staff_login_device_pair"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_staff_login_device_revoke"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_staff_pin_sign_in"]).toBe("service_role");
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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("resolves display PINs in the Worker without contacting the broker or issuing staff proof", async () => {
    const display = {
      kind: "display",
      branch_id: branch,
      display_token: "c".repeat(64),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    admin.rpc.mockResolvedValue({ data: { ok: true, ...display }, error: null });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const directRequest = Object.assign(request(), {
      runtime: { cloudflare: { env: { SUPABASE_URL: "https://database.example.invalid", SUPABASE_SERVICE_ROLE_KEY: "fixture" } } },
    });
    const response = await handler({ request: directRequest });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(display);
    expect(admin.rpc).toHaveBeenCalledWith("neo_staff_pin_sign_in", {
      _token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      _pin: "123456",
    });
    expect(admin.auth.admin.generateLink).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const requestFetch = vi.mocked(createClient).mock.calls[0]?.[2]?.global?.fetch;
    expect(requestFetch).toBeDefined();
    fetch.mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "https://other.example.invalid" },
    }));
    await expect(requestFetch!("https://database.example.invalid/rest/v1/rpc/neo_staff_pin_sign_in"))
      .rejects.toThrow("Unexpected redirect");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("keeps a rejected direct PIN attempt out of the broker", async () => {
    vi.stubEnv("SUPABASE_URL", "https://database.example.invalid");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture");
    admin.rpc.mockResolvedValue({ data: { ok: false, reason: "locked" }, error: null });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await handler({ request: request() });
    expect(response.status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the broker when the database gateway rejects the Worker credential", async () => {
    vi.stubEnv("SUPABASE_URL", "https://database.example.invalid");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture");
    admin.rpc.mockResolvedValue({ data: null, error: { code: "PGRST301", message: "JWT rejected" } });
    const fetch = vi.fn().mockResolvedValue(Response.json({ token_hash: "staff-proof", branch_id: branch }));
    vi.stubGlobal("fetch", fetch);
    const response = await handler({ request: request() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token_hash: "staff-proof", branch_id: branch });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("issues a personal account proof for the worker resolved by the device", async () => {
    vi.stubEnv("SUPABASE_URL", "https://database.example.invalid");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture");
    const worker = "00000000-0000-4000-8000-000000000002";
    admin.rpc.mockResolvedValue({ data: { ok: true, branch_id: branch, user_id: worker }, error: null });
    admin.auth.admin.getUserById.mockResolvedValue({ data: { user: { email: "worker@example.invalid" } }, error: null });
    admin.auth.admin.generateLink.mockResolvedValue({ data: { properties: { hashed_token: "staff-proof" } }, error: null });
    const response = await handler({ request: request() });
    expect(response.status).toBe(200);
    expect(admin.auth.admin.getUserById).toHaveBeenCalledWith(worker);
    expect(await response.json()).toEqual({ token_hash: "staff-proof", branch_id: branch });
  });

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
    expect(init.redirect).toBe("manual");
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
  it("returns only a restricted display proof for a display PIN", async () => {
    const display = {
      kind: "display",
      branch_id: branch,
      display_token: "c".repeat(64),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ...display,
      token_hash: "unexpected-staff-proof",
    })));
    const response = await handler({ request: request() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(display);
  });
  it("rejects redirects without forwarding the device token or PIN to another host", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302, headers: { Location: "https://foreign.invalid" },
    }));
    vi.stubGlobal("fetch", fetch);
    expect((await handler({ request: request() })).status).toBe(502);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1].redirect).toBe("manual");
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

it("keeps a display credential out of the personal account sign-in flow", async () => {
  const branch = "00000000-0000-4000-8000-000000000001";
  const displayToken = "c".repeat(64);
  const storage = (entries: [string, string][]) => {
    const values = new Map(entries);
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
  };
  const localStorage = storage([[STAFF_DEVICE_TOKEN_KEY, `neowd_${"a".repeat(64)}`]]);
  const sessionStorage = storage([[STAFF_PIN_SESSION_KEY, "1"]]);
  vi.stubGlobal("window", { localStorage, sessionStorage });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    kind: "display",
    branch_id: branch,
    display_token: displayToken,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  })));
  auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  try {
    await expect(signInWithStaffPin("135790", branch)).resolves.toEqual({ kind: "display", branchId: branch });
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(localStorage.getItem(DISPLAY_TOKEN_STORAGE_KEY)).toBe(displayToken);
    expect(sessionStorage.getItem(STAFF_PIN_SESSION_KEY)).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
