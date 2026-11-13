import { describe, expect, it, vi } from "vitest";
import { protectDynamicResponse } from "@/lib/web-response-policy";
import { forwardLovableMpesaRequest } from "../../server";
describe("deployed dynamic response cache/privacy boundary", () => {
  it.each([200, 401, 403, 500])(
    "prevents shared/stale caching for status %s without dropping content",
    async (status) => {
      const response = protectDynamicResponse(
        new Response("private or current document", {
          status,
          headers: { "Content-Type": "text/html", "Cache-Control": "public,max-age=3600" },
        }),
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
      expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe("private or current document");
    },
  );
  it("preserves redirect, authentication and cookie headers", () => {
    const headers = new Headers({ Location: "/auth", "WWW-Authenticate": "Bearer" });
    headers.append("Set-Cookie", "one=1; HttpOnly");
    headers.append("Set-Cookie", "two=2; HttpOnly");
    const response = protectDynamicResponse(new Response(null, { status: 302, headers }));
    expect(response.headers.get("Location")).toBe("/auth");
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });
});

describe("optional existing Lovable M-Pesa transport", () => {
  const settings = "a298d96ac388c4c939b606b376547f88b23dbf95f9c193d59a8926c1baf2f8c0";
  const charge = "9da0afc433195f41243eb2d86b167de79fb5b2707cfbb1bda8088afd3d76f3fd";
  const enabled = { NEO_LOVABLE_BRIDGE_ENABLED: "true" };
  const request = (id = settings, init: RequestInit = {}) =>
    new Request(`https://neo-preview.neo-hospitality.workers.dev/_serverFn/${id}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test.payload.signature",
        Origin: "https://neo-preview.neo-hospitality.workers.dev",
        "Content-Type": "application/json",
      },
      body: "{}",
      ...init,
    });
  const upstream = () => vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));

  it("leaves current execution unchanged unless explicitly enabled", async () => {
    const fetch = upstream();
    expect(
      await forwardLovableMpesaRequest(request(), { NEO_LOVABLE_BRIDGE_ENABLED: "false" }, fetch),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not loop when the same source is installed on Horizon", async () => {
    const fetch = upstream();
    expect(
      await forwardLovableMpesaRequest(
        new Request(`https://horizon-prime-os.lovable.app/_serverFn/${settings}`, {
          method: "POST",
        }),
        enabled,
        fetch,
      ),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not proxy arbitrary routes or server functions", async () => {
    const fetch = upstream();
    expect(await forwardLovableMpesaRequest(request("0".repeat(64)), enabled, fetch)).toBeNull();
    expect(
      await forwardLovableMpesaRequest(
        new Request("https://neo-preview.neo-hospitality.workers.dev/api/public/print-agent/claim"),
        enabled,
        fetch,
      ),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["", "Bearer sb_secret_synthetic", "Bearer malformed"])(
    "rejects missing or non-session authorization %s",
    async (auth) => {
      const fetch = upstream();
      const result = await forwardLovableMpesaRequest(
        request(settings, { headers: { Authorization: auth } }),
        enabled,
        fetch,
      );
      expect(result?.status).toBe(401);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("rejects a foreign browser origin before rewriting the upstream origin", async () => {
    const fetch = upstream();
    const result = await forwardLovableMpesaRequest(
      request(settings, {
        headers: { Authorization: "Bearer a.b.c", Origin: "https://foreign.invalid" },
      }),
      enabled,
      fetch,
    );
    expect(result?.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a cross-site fetch even when the Origin header is absent", async () => {
    const fetch = upstream();
    const result = await forwardLovableMpesaRequest(
      request(settings, {
        headers: { Authorization: "Bearer a.b.c", "sec-fetch-site": "cross-site" },
      }),
      enabled,
      fetch,
    );
    expect(result?.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires POST and refuses query-string overrides", async () => {
    const fetch = upstream();
    expect(
      (
        await forwardLovableMpesaRequest(
          request(settings, { method: "GET", body: null }),
          enabled,
          fetch,
        )
      )?.status,
    ).toBe(405);
    const req = request();
    expect(
      (
        await forwardLovableMpesaRequest(
          new Request(req.url + "?url=https://foreign.invalid", req),
          enabled,
          fetch,
        )
      )?.status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps money-changing forwarding disabled independently of connection tests", async () => {
    const fetch = upstream();
    expect((await forwardLovableMpesaRequest(request(charge), enabled, fetch))?.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("forwards the unchanged protocol and caller JWT only to the fixed original handler", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("serialized-result", {
        headers: {
          "content-type": "application/x-ndjson",
          "x-tss-serialized": "true",
          "set-cookie": "upstream=private",
        },
      }),
    );
    const req = request(settings, {
      headers: {
        Authorization: "Bearer a.b.c",
        Origin: "https://neo-preview.neo-hospitality.workers.dev",
        "Content-Type": "application/json",
        Cookie: "private=cookie",
        "x-service-key": "must-not-forward",
      },
      body: '{"serialized":"payload"}',
    });
    const response = await forwardLovableMpesaRequest(req, enabled, fetch);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe(
      `https://horizon-prime-os.lovable.app/_serverFn/${settings}`,
    );
    const init = fetch.mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer a.b.c");
    expect(headers.get("origin")).toBe("https://horizon-prime-os.lovable.app");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-service-key")).toBeNull();
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('{"serialized":"payload"}');
    expect(init.redirect).toBe("error");
    expect(response?.headers.get("x-tss-serialized")).toBe("true");
    expect(response?.headers.get("set-cookie")).toBeNull();
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(await response?.text()).toBe("serialized-result");
  });
  it("preserves an original authorization denial without converting it to success", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ message: "Forbidden" }, { status: 403 }));
    expect((await forwardLovableMpesaRequest(request(), enabled, fetch))?.status).toBe(403);
  });
  it("forwards a payment only after the separate safety gate is explicitly enabled", async () => {
    const fetch = upstream();
    expect(
      (
        await forwardLovableMpesaRequest(
          request(charge),
          { ...enabled, NEO_LOVABLE_BRIDGE_PAYMENTS_ENABLED: "true" },
          fetch,
        )
      )?.status,
    ).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("never retries a lost upstream response or falls back to another payment dispatch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("timeout"));
    const response = await forwardLovableMpesaRequest(
      request(charge),
      { ...enabled, NEO_LOVABLE_BRIDGE_PAYMENTS_ENABLED: "true" },
      fetch,
    );
    expect(response?.status).toBe(502);
    expect(await response?.text()).toContain("no automatic retry");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    new Response("sign in", { status: 302, headers: { Location: "https://foreign.invalid" } }),
    new Response("<html>app shell</html>", { headers: { "content-type": "text/html" } }),
  ])("refuses redirects and HTML shells as server-function results", async (upstreamResponse) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(upstreamResponse);
    expect((await forwardLovableMpesaRequest(request(), enabled, fetch))?.status).toBe(502);
  });
  it("bounds the streamed request body and rejects non-JSON uploads", async () => {
    const fetch = upstream();
    expect(
      (
        await forwardLovableMpesaRequest(
          request(settings, { body: "x".repeat(32769) }),
          enabled,
          fetch,
        )
      )?.status,
    ).toBe(413);
    expect(
      (
        await forwardLovableMpesaRequest(
          request(settings, {
            headers: { Authorization: "Bearer a.b.c", "Content-Type": "text/plain" },
          }),
          enabled,
          fetch,
        )
      )?.status,
    ).toBe(415);
    expect(fetch).not.toHaveBeenCalled();
  });
});
