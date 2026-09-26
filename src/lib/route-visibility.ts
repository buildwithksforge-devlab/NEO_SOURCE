/**
 * Canonical route visibility registry.
 *
 * Search visibility is decided by what a route contains, never by a Lighthouse
 * score. A route is either PUBLIC_INDEXABLE — marketing content any visitor may
 * read — or PRIVATE_NOINDEX — someone's stay, order, money, account or a staff
 * workspace. Private routes are blocked from indexing and never enter the
 * sitemap; that is the correct outcome, not a defect.
 */

const configuredPublicOrigin = (import.meta.env["VITE_PUBLIC_SITE_URL"] ?? "").trim().replace(/\/+$/, "");

/** Public origin used for canonical URLs and social metadata. */
export const PRODUCTION_ORIGIN =
  configuredPublicOrigin || "https://horizon-prime-os.lovable.app";

export type RouteVisibility = "PUBLIC_INDEXABLE" | "PRIVATE_NOINDEX";

/**
 * Public marketing surfaces. Patterns use `:slug` for a single path segment.
 */
export const PUBLIC_INDEXABLE_ROUTES = [
  "/",
  "/start/:slug",
  "/guest/:slug",
  "/guest/:slug/explore",
  "/guest/:slug/book",
] as const;

/**
 * Anything that belongs to one person, one account or one operation. Listed
 * as prefixes: everything beneath them inherits the classification.
 */
export const PRIVATE_PREFIXES = [
  "/auth",
  "/workspace",
  "/work",
  "/admin",
  "/partner",
  "/rider",
  "/platform",
  "/checkout",
] as const;

/** Private guest sub-paths under /guest/:slug/… */
export const PRIVATE_GUEST_SEGMENTS = [
  "track",
  "stay",
  "orders",
  "order",
  "folio",
  "account",
  "profile",
  "settings",
  "notifications",
  "trips",
  "transport",
  "laundry",
  "reservations",
  "signin",
] as const;

function matchesPattern(pattern: string, path: string): boolean {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return false;
  return p.every((seg, i) => (seg.startsWith(":") ? s[i]!.length > 0 : seg === s[i]));
}

/** Strip the query string and any trailing slash before classifying. */
export function normalisePath(input: string): string {
  const withoutQuery = input.split("?")[0]!.split("#")[0]!;
  if (withoutQuery === "/" || withoutQuery === "") return "/";
  return withoutQuery.replace(/\/+$/, "");
}

export function routeVisibility(input: string): RouteVisibility {
  const path = normalisePath(input);
  const segments = path.split("/").filter(Boolean);

  if (PRIVATE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return "PRIVATE_NOINDEX";
  }
  if (segments[0] === "guest" && segments.length >= 3) {
    return PRIVATE_GUEST_SEGMENTS.includes(segments[2] as (typeof PRIVATE_GUEST_SEGMENTS)[number])
      ? "PRIVATE_NOINDEX"
      : PUBLIC_INDEXABLE_ROUTES.some((pattern) => matchesPattern(pattern, path))
        ? "PUBLIC_INDEXABLE"
        : "PRIVATE_NOINDEX";
  }
  return PUBLIC_INDEXABLE_ROUTES.some((pattern) => matchesPattern(pattern, path))
    ? "PUBLIC_INDEXABLE"
    : "PRIVATE_NOINDEX";
}

export function isIndexable(path: string): boolean {
  return routeVisibility(path) === "PUBLIC_INDEXABLE";
}

/** The robots directive a route must carry. */
export function robotsDirective(path: string): string {
  return isIndexable(path) ? "index, follow" : "noindex, nofollow";
}

/** Absolute, self-referencing canonical URL on the production origin. */
export function canonicalUrl(path: string): string {
  const clean = normalisePath(path);
  return clean === "/" ? `${PRODUCTION_ORIGIN}/` : `${PRODUCTION_ORIGIN}${clean}`;
}

/**
 * The sitemap: the fixed public entry points plus one set of public pages for
 * every hotel that has deliberately switched on public discovery.
 */
export function sitemapPaths(publicPropertySlugs: string[]): string[] {
  const paths = ["/"];
  for (const slug of publicPropertySlugs) {
    paths.push(`/start/${slug}`, `/guest/${slug}`, `/guest/${slug}/explore`, `/guest/${slug}/book`);
  }
  return paths.filter(isIndexable);
}

/** Head meta entries every public route shares. */
export function publicHeadMeta(path: string) {
  return [{ name: "robots", content: robotsDirective(path) }];
}

export function canonicalLink(path: string) {
  return { rel: "canonical", href: canonicalUrl(path) };
}
