import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardManagedServiceRequest, MANAGED_SERVICE_OPERATIONS } from "../managed-service-relay";
const summary = "e98b312a6ceb488a8c655879fd1294414c8ca3f5371063378ad309e1c8c1f433";
const send = "32bd4c986b8e1dfc7931b605cc9ae4d0de993a9310f3f16d5d5d7e4a976714f2";
const reset = "e20a8cc2029e48b65ffca78a63d8472ccb9ff62eb7116120637621a56ed95c3f";
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
  it("allows only explicitly activated operations and keeps their user authority upstream", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    expect(
      (
        await forwardManagedServiceRequest(
          req(reset),
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
