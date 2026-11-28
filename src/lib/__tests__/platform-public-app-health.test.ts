// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPublicApp } from "@/lib/platform-public-app-health";

const delivery = { app: "delivery", slug: "garden", state: "published" } as const;
const html = (identity: string, build = "release") => new Response(`<head>
  <meta name="neo-public-property" content="${identity}">
  <meta name="neo-build-id" content="${build}">
</head>`);

afterEach(() => vi.unstubAllGlobals());

describe("public app readiness", () => {
  it("reports a Delivery publication HTTP 500 even when no publication is recorded", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    expect(await checkPublicApp({ ...delivery, state: "unpublished" }, "property", "release"))
      .toMatchObject({ status: "blocked", detail: expect.stringContaining("HTTP 500") });
    expect(fetch).toHaveBeenCalledWith("/delivery/garden", expect.objectContaining({ credentials: "omit", redirect: "manual" }));
  });

  it("requires the expected property and release on a successful response", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(html("delivery:other")).mockResolvedValueOnce(html("delivery:property", "old"))
      .mockResolvedValueOnce(html("delivery:property"));
    vi.stubGlobal("fetch", fetch);
    expect((await checkPublicApp(delivery, "property", "release")).status).toBe("blocked");
    expect((await checkPublicApp(delivery, "property", "release")).status).toBe("unverified");
    expect((await checkPublicApp(delivery, "property", "release")).status).toBe("verified");
  });

  it("rejects ambiguous publications and prevents requests to unchecked paths", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await checkPublicApp({ ...delivery, state: "ambiguous" }, "property", "release")).status).toBe("blocked");
    expect((await checkPublicApp({ ...delivery, slug: "//outside.example" }, "property", "release")).status).toBe("blocked");
    expect(fetch).not.toHaveBeenCalled();
  });
});
