# Guest Experience Quality Correction

Scope: the four public guest routes and everything reachable from them —
`/start/:propertySlug`, `/guest/:hotelSlug`, `/guest/:hotelSlug/explore`,
`/guest/:hotelSlug/track` (plus book, order, stay, orders, laundry, requests,
account, folio, reservation and order detail screens).

No canonical engine, RLS policy or finance projection is rewritten. This is a
presentation, performance, accessibility and verification pass on top of the
existing canonical data.

## 1. Layout stability (the worst current failure)

Explore currently shifts 0.478 on mobile because item thumbnails, skeletons and
the menu list all change size once data arrives.

- Give every guest image a fixed aspect-ratio box with explicit width/height,
  including the 56px menu thumbnails and the hotel hero on `/start`.
- Replace the spinner placeholders with skeletons whose height equals the real
  content (same row height, same card padding, same number of rows).
- Reserve height for the sticky guest tab bar, the preview banner and the
  contact footer so nothing is inserted above existing content after hydration.
- Keep empty and error states at the same block height as loaded state.
- Target CLS below 0.05 on mobile and desktop for all four routes.

## 2. Images and page weight

- Serve property and menu media through a sized, responsive image component
  with `srcset`/`sizes`, `loading="lazy"` below the fold, `decoding="async"`,
  and WebP/AVIF variants where the source allows it.
- Only the `/start` hero is preloaded; nothing else.
- Bundled assets get generated responsive variants; remote hotel media gets
  width hints so mobile never downloads the desktop original.

## 3. Bundle separation and code splitting

- Keep the public guest routes off the staff workspace graph: audit imports so
  no guest route pulls `AppShell`, RBAC, dashboards or admin code.
- Lazily load the heavier per-service screens (booking calendar, ordering cart,
  laundry list, tracking map/timeline) so the home and explore entries stay small.
- Remove render-blocking work at entry and trim unused JS from the guest chunks.

## 4. Accessibility

- AA contrast for every text/icon pair on the guest surfaces (the steel-on-white
  helper text and tab bar colours are the main offenders).
- Tab bar and all guest controls to at least 44x44 with real spacing.
- Accessible names on every icon-only control, labels tied to every field,
  `aria-live` on loading/success/error, logical heading order, visible focus,
  correct focus movement in dialogs, `alt` text on meaningful images and empty
  `alt` on decorative ones, and `prefers-reduced-motion` respected.

## 5. Semantics, SEO and agent readiness

- Real `<a>` links for navigation, buttons only for actions, stable accessible
  names, one `<main>`, proper landmarks.
- Unique title/description/canonical/Open Graph per public route, plus
  Hotel/LocalBusiness structured data on `/start/:propertySlug` from the
  property's own configured information only.
- `/guest/:hotelSlug/track`, stay, folio, orders and account stay `noindex` and
  out of the sitemap — a deliberate, recorded SEO reduction for privacy.

## 6. Functional validation (no new features, no invented data)

Walk each flow against Zuri on the live app and record the result: front door
resolution and honest unpublished state, guest home showing only enabled
services, rooms and booking idempotency, dining with station routing and
eligibility, My Stay folio arithmetic against the canonical projection, laundry
pricing and VAT, guest requests routing and single-charge behaviour, tracking
privacy against guessed references. Defects found inside these four routes get
fixed; anything outside is reported, not rebuilt.

## 7. Tests

Add focused tests for: responsive-image usage on guest routes, reserved-space /
skeleton-parity contract, touch-target and contrast tokens, guest-route bundle
isolation, noindex on private guest routes, property isolation on the public
resolvers, and the existing idempotency/folio invariants re-asserted from the
guest entry points.

## 8. Report

Publish, then run Lighthouse mobile + desktop on the four routes and report the
build revision, before/after scores, FCP, LCP, TBT, CLS, Speed Index, fixed
accessibility violations, scenarios executed, the intentional tracking-page SEO
reduction, and anything still failing.
