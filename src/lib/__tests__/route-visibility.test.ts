/**
 * Search visibility contract.
 *
 * Public marketing pages must be indexable with one canonical URL on the
 * production origin. Anything that belongs to a person or an operation must be
 * noindex and must never appear in the sitemap — a low SEO score on a tracking
 * page is privacy working, not a defect.
 */
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_ORIGIN,
  canonicalUrl,
  isIndexable,
  robotsDirective,
  routeVisibility,
  sitemapPaths,
} from "@/lib/route-visibility";

const PUBLIC = [
  "/",
  "/start/savanna-crown-nairobi",
  "/guest/savanna-crown-nairobi",
  "/guest/savanna-crown-nairobi/explore",
  "/guest/savanna-crown-nairobi/book",
];

const PRIVATE = [
  "/auth",
  "/workspace",
  "/admin/experience-studio",
  "/partner/zuri-crest",
  "/rider/jobs",
  "/guest/zuri-crest/track",
  "/guest/zuri-crest/stay",
  "/guest/zuri-crest/folio",
  "/guest/zuri-crest/orders",
  "/guest/zuri-crest/orders/ORD-1",
  "/guest/zuri-crest/profile",
  "/guest/zuri-crest/settings",
  "/guest/zuri-crest/signin",
  "/guest/zuri-crest/reservations/RES-1",
];

describe("route classification", () => {
  it.each(PUBLIC)("keeps %s indexable", (path) => {
    expect(routeVisibility(path)).toBe("PUBLIC_INDEXABLE");
    expect(robotsDirective(path)).toBe("index, follow");
  });

  it.each(PRIVATE)("keeps %s out of search results", (path) => {
    expect(routeVisibility(path)).toBe("PRIVATE_NOINDEX");
    expect(robotsDirective(path)).toBe("noindex, nofollow");
  });

  it("treats an unknown route as private until it is classified", () => {
    expect(isIndexable("/some/unknown/surface")).toBe(false);
  });
});

describe("canonical URLs", () => {
  it("uses the production origin", () => {
    expect(canonicalUrl("/start/zuri")).toBe(`${PRODUCTION_ORIGIN}/start/zuri`);
    expect(canonicalUrl("/")).toBe(`${PRODUCTION_ORIGIN}/`);
  });

  it("collapses query strings and trailing slashes to one clean URL", () => {
    expect(canonicalUrl("/guest/zuri/explore?tab=dining")).toBe(canonicalUrl("/guest/zuri/explore"));
    expect(canonicalUrl("/start/zuri/")).toBe(canonicalUrl("/start/zuri"));
  });
});

describe("sitemap", () => {
  const paths = sitemapPaths(["savanna-crown-nairobi"]);

  it("lists only public canonical routes", () => {
    expect(paths.every(isIndexable)).toBe(true);
    expect(paths).toContain("/guest/savanna-crown-nairobi/explore");
  });

  it("never lists a tracking, folio, stay or account URL", () => {
    for (const path of paths) {
      expect(path).not.toMatch(/\/(track|folio|stay|orders|account|profile|settings|signin)\b/);
    }
  });

  it("lists nothing for a hotel that has not published a public page", () => {
    expect(sitemapPaths([])).toEqual(["/"]);
  });
});
