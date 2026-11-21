import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardManagedPrintRequest } from "../managed-print-relay";
const enabled = { NEO_MANAGED_PRINT_ENABLED: "true" };
const id = "00000000-0000-4000-8000-000000000001";
const claim = "00000000-0000-4000-8000-000000000002";
const token = "neopc_" + "a".repeat(64);
function request(action = "printers", body: unknown = {}, init: RequestInit = {}) {
  return new Request(`https://neo.test/api/public/print-agent/${action}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      cookie: "private-cookie",
      apikey: "never-forward",
      "x-extra": "never-forward",
    },
    body: JSON.stringify(body),
    ...init,
  });
}
afterEach(() => vi.unstubAllEnvs());
describe("managed print execution boundary", () => {
  it("defaults off, ignores unrelated routes and never loops on the managed host", async () => {
    vi.stubEnv("NEO_MANAGED_PRINT_ENABLED", "");
    const upstream = vi.fn<typeof fetch>();
    expect(await forwardManagedPrintRequest(request(), {}, upstream)).toBeNull();
    expect(
      await forwardManagedPrintRequest(new Request("https://neo.test/auth"), enabled, upstream),
    ).toBeNull();
    expect(
      await forwardManagedPrintRequest(
        new Request("https://horizon-prime-os.lovable.app/api/public/print-agent/printers"),
        enabled,
        upstream,
      ),
    ).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });
  it("forwards only the agent token to the fixed existing endpoint", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { printers: [{ id, name: "Receipt" }] },
          { headers: { "set-cookie": "must-not-copy" } },
        ),
      );
    const result = await forwardManagedPrintRequest(
      request("printers", { url: "https://foreign.invalid", sql: "do not forward" }),
      enabled,
      upstream,
    );
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0]![0]).toBe(
      "https://horizon-prime-os.lovable.app/api/public/print-agent/printers",
    );
    const init = upstream.mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("apikey")).toBeNull();
    expect(init.body).toBe("{}");
    expect(init.redirect).toBe("manual");
    expect(result?.headers.get("set-cookie")).toBeNull();
    expect(result?.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each([
    ["claim", { printer_id: id }, { job: { job_id: id, claim_id: claim } }],
    ["claim", { printer_id: id }, { job: null }],
    [
      "finish",
      { job_id: id, claim_id: claim, outcome: "outcome_unknown" },
      { status: { status: "failed" } },
    ],
    ["discovery", {}, { request: { request_id: id, kind: "bluetooth" } }],
    ["discovery", {}, { request: null }],
    ["discovered", { request_id: id, result: { printers: [] } }, { ok: true }],
  ])("preserves the existing %s action protocol", async (action, body, result) => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
    const response = await forwardManagedPrintRequest(
      request(action as string, body),
      enabled,
      upstream,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(result);
    const forwarded = JSON.parse(String(upstream.mock.calls[0]![1]!.body));
    if (action === "finish")
      expect(forwarded).toMatchObject({ job_id: id, claim_id: claim, outcome: "outcome_unknown" });
  });
  it.each([
    ["unknown", {}, 404],
    ["printers?target=https://foreign.invalid", {}, 400],
    ["claim", {}, 400],
    ["finish", { job_id: id, claim_id: claim, outcome: "printed" }, 400],
    ["finish", { job_id: id, outcome: "completed" }, 400],
    ["discovered", { request_id: id, result: [] }, 400],
  ])("rejects invalid %s input without reaching either database", async (action, body, status) => {
    const upstream = vi.fn<typeof fetch>();
    expect(
      (await forwardManagedPrintRequest(request(action as string, body), enabled, upstream))
        ?.status,
    ).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects staff JWTs and missing agent credentials", async () => {
    const upstream = vi.fn<typeof fetch>();
    for (const authorization of ["Bearer header.payload.signature", "", "Bearer invalid"]) {
      expect(
        (
          await forwardManagedPrintRequest(
            request("printers", {}, { headers: { authorization } }),
            enabled,
            upstream,
          )
        )?.status,
      ).toBe(401);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 409, 413, 500, 503])(
    "preserves safe rejection for upstream %s without leaking internals",
    async (status) => {
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("database-secret-details", { status }));
      const response = await forwardManagedPrintRequest(request(), enabled, upstream);
      expect(response?.status).toBe(status < 500 ? status : 503);
      expect(await response?.text()).not.toContain("database-secret-details");
    },
  );
  it.each([{ printers: [{ id: "wrong" }] }, {}, { ok: true }])(
    "does not treat unrelated JSON as a printer list",
    async (result) => {
      const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
      expect((await forwardManagedPrintRequest(request(), enabled, upstream))?.status).toBe(502);
    },
  );
  it("does not follow redirects or treat an HTML shell as the API", async () => {
    for (const response of [
      new Response(null, { status: 302, headers: { location: "https://foreign.invalid" } }),
      new Response("<html>app</html>", { headers: { "content-type": "text/html" } }),
    ]) {
      const upstream = vi.fn<typeof fetch>().mockResolvedValue(response);
      expect((await forwardManagedPrintRequest(request(), enabled, upstream))?.status).toBe(502);
    }
  });
  it("never retries or falls back locally after an unknown claim outcome", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstream = vi.fn<typeof fetch>().mockRejectedValue(new Error(`request lost ${token}`));
    const response = await forwardManagedPrintRequest(
      request("claim", { printer_id: id }),
      enabled,
      upstream,
    );
    expect(response?.status).toBe(503);
    expect(upstream).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    log.mockRestore();
  });
  it("bounds payloads before forwarding", async () => {
    const upstream = vi.fn<typeof fetch>();
    expect(
      (
        await forwardManagedPrintRequest(
          request("claim", { extra: "x".repeat(4097) }),
          enabled,
          upstream,
        )
      )?.status,
    ).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
});
