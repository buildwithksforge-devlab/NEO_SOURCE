import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const req = vi.hoisted(() => ({ current: null as Request | null }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => req.current }));

import {
  BRIDGE_HEADER,
  bridgeTarget,
  checkBridgeKey,
  forwardRaw,
  runMpesaViaBridge,
} from "../neo-bridge.server";

const SECRET = "s".repeat(40);
const LIVE = "https://horizon-prime-os.lovable.app";

function withKey(key?: string, url = `${LIVE}/api/public/bridge/x`) {
  const headers = new Headers({ "content-type": "application/json" });
  if (key !== undefined) headers.set(BRIDGE_HEADER, key);
  return new Request(url, { method: "POST", headers, body: "{}" });
}

beforeEach(() => {
  delete process.env["NEO_BRIDGE_SECRET"];
  delete process.env["NEO_BRIDGE_ORIGIN"];
});
afterEach(() => {
  vi.unstubAllGlobals();
  req.current = null;
});

describe("live side: shared bridge password", () => {
  it("refuses every call while no password is set", async () => {
    expect(await checkBridgeKey(withKey(SECRET))).toBe("unconfigured");
  });
  it("treats a password shorter than 32 characters as not set", async () => {
    process.env["NEO_BRIDGE_SECRET"] = "short-password";
    expect(await checkBridgeKey(withKey("short-password"))).toBe("unconfigured");
  });
  it("accepts only the exact password", async () => {
    process.env["NEO_BRIDGE_SECRET"] = SECRET;
    expect(await checkBridgeKey(withKey(SECRET))).toBe("ok");
    expect(await checkBridgeKey(withKey(`${SECRET}x`))).toBe("invalid");
    expect(await checkBridgeKey(withKey())).toBe("invalid");
  });
});

describe("local side: when to forward", () => {
  it("does not forward on the live app (no NEO_BRIDGE_ORIGIN)", () => {
    process.env["NEO_BRIDGE_SECRET"] = SECRET;
    expect(bridgeTarget(withKey())).toBeNull();
  });
  it("forwards when both settings are present", () => {
    process.env["NEO_BRIDGE_SECRET"] = SECRET;
    process.env["NEO_BRIDGE_ORIGIN"] = `${LIVE}/`;
    expect(bridgeTarget(withKey(undefined, "http://localhost:8080/api/public/x"))).toEqual({ origin: LIVE, secret: SECRET });
  });
  it("never forwards a call that already came through a bridge, or to itself", () => {
    process.env["NEO_BRIDGE_SECRET"] = SECRET;
    process.env["NEO_BRIDGE_ORIGIN"] = LIVE;
    expect(bridgeTarget(withKey(SECRET, "http://localhost:8080/x"))).toBeNull();
    expect(bridgeTarget(withKey(undefined, `${LIVE}/x`))).toBeNull();
  });
  it("refuses a plain-http live address", () => {
    process.env["NEO_BRIDGE_SECRET"] = SECRET;
    process.env["NEO_BRIDGE_ORIGIN"] = "http://horizon-prime-os.lovable.app";
    expect(bridgeTarget(null)).toBeNull();
  });
});

describe("forwarding", () => {
  beforeEach(() => {
    process.env["NEO_BRIDGE_SECRET"] = SECRET;
    process.env["NEO_BRIDGE_ORIGIN"] = LIVE;
  });

  it("sends only the named headers plus the bridge password, never cookies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const incoming = new Request("http://localhost:8080/api/public/staff-pin-login", {
      method: "POST",
      headers: { "x-neo-device-token": "neowd_x", "content-type": "application/json", cookie: "sb=secret", origin: "http://localhost:8080" },
      body: JSON.stringify({ pin: "000000" }),
    });
    const res = await forwardRaw({ origin: LIVE, secret: SECRET }, "/api/public/bridge/staff-pin-login", incoming, ["x-neo-device-token", "content-type"]);
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${LIVE}/api/public/bridge/staff-pin-login`);
    const sent = new Headers(init.headers);
    expect(sent.get(BRIDGE_HEADER)).toBe(SECRET);
    expect(sent.get("x-neo-device-token")).toBe("neowd_x");
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("origin")).toBeNull();
    expect(init.body).toBe(JSON.stringify({ pin: "000000" }));
  });

  it("runs M-Pesa as the same signed-in staff member on the live app", async () => {
    req.current = new Request("http://localhost:8080/_serverFn/x", { headers: { authorization: "Bearer a.b.c" } });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ result: { ok: true, status: "pending" } }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await runMpesaViaBridge("chargeWithMpesa", { orderId: "o1", phone: "254700000000", amount: 1381 });
    expect(out).toEqual({ result: { ok: true, status: "pending" } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${LIVE}/api/public/bridge/mpesa/chargeWithMpesa`);
    const sent = new Headers(init.headers);
    expect(sent.get("authorization")).toBe("Bearer a.b.c");
    expect(sent.get(BRIDGE_HEADER)).toBe(SECRET);
  });

  it("refuses M-Pesa through the bridge without a staff sign-in", async () => {
    req.current = new Request("http://localhost:8080/_serverFn/x");
    vi.stubGlobal("fetch", vi.fn());
    await expect(runMpesaViaBridge("chargeWithMpesa", {})).rejects.toThrow(/Unauthorized/);
  });

  it("refuses names outside the M-Pesa list", async () => {
    req.current = new Request("http://localhost:8080/_serverFn/x", { headers: { authorization: "Bearer a.b.c" } });
    vi.stubGlobal("fetch", vi.fn());
    await expect(runMpesaViaBridge("deleteEverything", {})).rejects.toThrow(/cannot run/);
  });

  it("reports a wrong bridge password clearly", async () => {
    req.current = new Request("http://localhost:8080/_serverFn/x", { headers: { authorization: "Bearer a.b.c" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "bridge_unauthorized" }, { status: 401 })));
    await expect(runMpesaViaBridge("testMpesaConnection", {})).rejects.toThrow(/bridge password/);
  });
});
