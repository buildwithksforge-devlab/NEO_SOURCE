import { afterEach, describe, expect, it, vi } from "vitest";
const local = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: local.fetch } }));
import server from "../../server";
const url = "https://neo-preview.neo-hospitality.workers.dev/api/public/print-agent/printers";
const request = () =>
  new Request(url, {
    method: "POST",
    headers: {
      authorization: "Bearer neopc_" + "0".repeat(64),
      "content-type": "application/json",
    },
    body: "{}",
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("print routing before the local privileged executor", () => {
  it("returns the managed response without loading the local app/database route", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ printers: [] }));
    vi.stubGlobal("fetch", upstream);
    const response = await server.fetch(request(), { NEO_MANAGED_PRINT_ENABLED: "true" }, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ printers: [] });
    expect(local.fetch).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledOnce();
  });
  it("does not fall back to the rejected local credential after upstream failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 })),
    );
    expect((await server.fetch(request(), { NEO_MANAGED_PRINT_ENABLED: "true" }, {})).status).toBe(
      503,
    );
    expect(local.fetch).not.toHaveBeenCalled();
  });
  it("retains the existing route when managed printing is disabled", async () => {
    local.fetch.mockResolvedValue(Response.json({ local: true }));
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    expect((await server.fetch(request(), { NEO_MANAGED_PRINT_ENABLED: "false" }, {})).status).toBe(
      200,
    );
    expect(local.fetch).toHaveBeenCalledOnce();
    expect(upstream).not.toHaveBeenCalled();
  });
  it("reads Nitro's request-local Cloudflare binding when the SSR environment argument is absent", async () => {
    const req = request();
    Object.defineProperty(req, "runtime", {
      value: { name: "cloudflare", cloudflare: { env: { NEO_MANAGED_PRINT_ENABLED: "true" } } },
    });
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ printers: [] }));
    vi.stubGlobal("fetch", upstream);
    expect((await server.fetch(req, undefined, {})).status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect(local.fetch).not.toHaveBeenCalled();
  });
});
