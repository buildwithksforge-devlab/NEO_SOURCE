import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardManagedServiceRequest, MANAGED_SERVICE_OPERATIONS } from "../managed-service-relay";
const summary = "e98b312a6ceb488a8c655879fd1294414c8ca3f5371063378ad309e1c8c1f433";
const send = "32bd4c986b8e1dfc7931b605cc9ae4d0de993a9310f3f16d5d5d7e4a976714f2";
const reset = "e20a8cc2029e48b65ffca78a63d8472ccb9ff62eb7116120637621a56ed95c3f";
const requireChange = "b6ebab684d537948ca21b93e8e2e13fe897e2ece52683e5f75d6dad375ade8ae";
const read = { NEO_MANAGED_COMMS_ENABLED: "true" };
const req = (id = summary, init: RequestInit = {}) =>
  new Request(`https://neo.test/_serverFn/${id}`, {
    method: "POST",
    headers: {
      authorization: "Bearer test.payload.signature",
      "content-type": "application/json",
      origin: "https://neo.test",
      cookie: "private-cookie",
      apikey: "must-not-forward",
    },
    body: '{"data":{}}',
    ...init,
  });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("conditional existing managed communications and account routes", () => {
  it("leaves unrelated and disabled operations alone", async () => {
    vi.stubEnv("NEO_MANAGED_COMMS_ENABLED", "");
    const f = vi.fn<typeof fetch>();
    expect(await forwardManagedServiceRequest(req(), {}, f)).toBeNull();
    expect(await forwardManagedServiceRequest(req("0".repeat(64)), read, f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it("forwards caller JWT and framework payload to fixed Horizon only", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ masked: true }, { headers: { "set-cookie": "drop" } }));
    const response = await forwardManagedServiceRequest(req(), read, f);
    expect(f.mock.calls[0]![0]).toBe(`https://horizon-prime-os.lovable.app/_serverFn/${summary}`);
    const init = f.mock.calls[0]![1]!;
    expect(init.redirect).toBe("manual");
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBe("Bearer test.payload.signature");
    expect(h.get("cookie")).toBeNull();
    expect(h.get("apikey")).toBeNull();
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('{"data":{}}');
    expect(response?.headers.get("set-cookie")).toBeNull();
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
  });
  it("does not release sending or account changes with only connectivity enabled", async () => {
    const f = vi.fn<typeof fetch>();
    expect((await forwardManagedServiceRequest(req(send), read, f))?.status).toBe(503);
    expect(
      (await forwardManagedServiceRequest(req(reset), { NEO_MANAGED_USERS_ENABLED: "true" }, f))
        ?.status,
    ).toBe(503);
    expect(f).not.toHaveBeenCalled();
  });
  it("reads Nitro request-local configuration", async () => {
    const r = req();
    Object.defineProperty(r, "runtime", { value: { cloudflare: { env: read } } });
    const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ masked: true }));
    expect((await forwardManagedServiceRequest(r, {}, f))?.status).toBe(200);
  });
  it.each([reset, requireChange])("allows explicitly activated account operation %s and keeps authority upstream", async (id) => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    expect(
      (
        await forwardManagedServiceRequest(
          req(id),
          { NEO_MANAGED_USERS_ENABLED: "true", NEO_MANAGED_USERS_ACTIONS_ENABLED: "true" },
          f,
        )
      )?.status,
    ).toBe(200);
    expect(f).toHaveBeenCalledOnce();
  });
  it.each([
    ["?url=https://foreign.invalid", 400],
    ["/extra", 404],
  ] as const)("never permits a query or arbitrary operation suffix %s", async (suffix, status) => {
    const f = vi.fn<typeof fetch>();
    const r = new Request(`https://neo.test/_serverFn/${summary}${suffix}`, { method: "POST" });
    const response = await forwardManagedServiceRequest(r, read, f);
    if (status === 404) expect(response).toBeNull();
    else expect(response?.status).toBe(status);
    expect(f).not.toHaveBeenCalled();
  });
  it("rejects anonymous, cross-site and oversized requests", async () => {
    const f = vi.fn<typeof fetch>();
    expect(
      (await forwardManagedServiceRequest(req(summary, { headers: {} }), read, f))?.status,
    ).toBe(401);
    expect(
      (
        await forwardManagedServiceRequest(
          req(summary, { headers: { origin: "https://foreign.invalid" } }),
          read,
          f,
        )
      )?.status,
    ).toBe(403);
    expect(
      (await forwardManagedServiceRequest(req(summary, { body: "x".repeat(32769) }), read, f))
        ?.status,
    ).toBe(413);
    expect(f).not.toHaveBeenCalled();
  });
  it("preserves serialized framework errors without turning them into success", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{"error":"denied"}', {
          status: 403,
          headers: { "content-type": "application/json", "x-tss-serialized": "true" },
        }),
      );
    expect((await forwardManagedServiceRequest(req(), read, f))?.status).toBe(403);
  });
  it("rejects HTML and redirects", async () => {
    for (const value of [
      new Response("<html>", { headers: { "content-type": "text/html" } }),
      new Response(null, { status: 302, headers: { location: "https://foreign.invalid" } }),
    ]) {
      const f = vi.fn<typeof fetch>().mockResolvedValue(value);
      expect((await forwardManagedServiceRequest(req(), read, f))?.status).toBe(502);
    }
  });
  it("never retries or falls back after a lost sending response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret"));
    expect(
      (
        await forwardManagedServiceRequest(
          req(send),
          { ...read, NEO_MANAGED_COMMS_ACTIONS_ENABLED: "true" },
          f,
        )
      )?.status,
    ).toBe(503);
    expect(f).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });
  it("does not route ordinary recovery email to the older Horizon invitation implementation", () => {
    expect(
      [...MANAGED_SERVICE_OPERATIONS.values()].some((x) => x.name === "resendStaffInvitation"),
    ).toBe(false);
  });
});

describe("managed Simulation", () => {
  const health = "e147f1a7d3e4fa6db8c865a12a139885a10acd9f524b22965821cd6eec8c7b55";
  const run = "375cd295efdbb60b57f3139b04766ba70d3091f31a8bca9490bc5dd3b9821724";
  const statusOnly = {
    NEO_MANAGED_SIMULATION_ENABLED: "true",
    NEO_MANAGED_SIMULATION_ACTIONS_ENABLED: "false",
  };
  const actions = { ...statusOnly, NEO_MANAGED_SIMULATION_ACTIONS_ENABLED: "true" };
  const horizon = "https://horizon-prime-os.lovable.app/_serverFn/";

  it("allows the authenticated GET without a body or any API key", async () => {
    const fetchHorizon = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ available: true }));
    const response = await forwardManagedServiceRequest(
      req(health, { method: "GET", body: null }),
      statusOnly,
      fetchHorizon,
    );
    expect(response?.status).toBe(200);
    expect(fetchHorizon).toHaveBeenCalledOnce();
    const [url, init] = fetchHorizon.mock.calls[0]!;
    expect(url).toBe(horizon + health);
    expect(init).toMatchObject({ method: "GET", body: null, redirect: "manual" });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test.payload.signature");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("apikey")).toBe(false);
  });

  it("keeps test actions gated and restricts the health route to GET", async () => {
    const fetchHorizon = vi.fn<typeof fetch>();
    expect((await forwardManagedServiceRequest(req(run), statusOnly, fetchHorizon))?.status).toBe(503);
    expect((await forwardManagedServiceRequest(req(health), statusOnly, fetchHorizon))?.status).toBe(405);
    expect(fetchHorizon).not.toHaveBeenCalled();
  });

  it.each([404, 200])("does not send a test action to an unverified Horizon build (%s)", async (status) => {
    const fetchHorizon = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status }));
    expect((await forwardManagedServiceRequest(req(run), actions, fetchHorizon))?.status).toBe(503);
    expect(fetchHorizon).toHaveBeenCalledOnce();
    expect(fetchHorizon.mock.calls[0]![0]).toBe(horizon + health);
  });

  it("sends the original request once after Horizon verifies the Simulation contract", async () => {
    const fetchHorizon = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(
        { available: true },
        { headers: { "x-neo-simulation-contract": "routed-cash-journal-v1" } },
      ))
      .mockResolvedValueOnce(Response.json({ state: "completed" }));
    const body = '{"data":{}}';
    const response = await forwardManagedServiceRequest(req(run, { body }), actions, fetchHorizon);
    expect(response?.status).toBe(200);
    expect(fetchHorizon).toHaveBeenCalledTimes(2);
    const [check, execute] = fetchHorizon.mock.calls;
    expect(check?.[0]).toBe(horizon + health);
    expect(check?.[1]?.method).toBe("GET");
    expect(new Headers(check?.[1]?.headers).get("authorization")).toBe("Bearer test.payload.signature");
    expect(execute?.[0]).toBe(horizon + run);
    expect(execute?.[1]?.method).toBe("POST");
    expect(new TextDecoder().decode(execute?.[1]?.body as Uint8Array)).toBe(body);
  });
});
