# NEØ codebase verification checkpoint — 23 September 2026

## Outcome

- Production build: **PASS**
- Production server smoke (`/`, `/auth`): **PASS**
- TypeScript (`tsc --noEmit`): **PASS**
- Test suite: **3,252 passed, 169 intentionally skipped, 4 environment-blocked**
- Connected commerce suite: **210 passed, 14 intentionally skipped**

The four remaining failures are not local application assertions:

1. `live-security.test.ts` requires a read-only PostgreSQL connection (`PGHOST`).
2. The live anonymous Data API boundary check cannot reach the deployed Supabase endpoint from this restricted runner.
3. The signed-out HR reconciliation check cannot reach that endpoint.
4. The signed-out index-coverage check cannot reach that endpoint.

Run these four checks in CI or a trusted environment with the read-only database
and Supabase variables configured. They are not marked passed here.

## Corrections made

- Added canonical POS/payment journal resolution for receipts rooted in
  `payment_attempts`, including POS payments and their posted journals.
- Made Payment Register loading/error state include lifecycle failures instead
  of silently showing incomplete results.
- Corrected property-local reporting and PMS calendar dates so Nairobi dates do
  not shift to the previous UTC day.
- Registered Station Stock in the shared authorization capability map.
- Completed the callable RPC manifest and moved browser calls through the
  guarded RPC path; sitemap calls use the trusted server path.
- Replaced the last native date inputs with the shared NEØ date picker.
- Made pull-to-refresh refetch active canonical queries without reloading the
  document or coupling the header to a router provider.
- Replaced raw provider errors on reconciliation and Pastry screens with the
  shared actionable error state.
- Corrected the onboarding relationship contract for resolve-only item-group
  context.
- Updated stale header, folio, document, role-surface and UX audit contracts to
  the current canonical UI and financial vocabulary.
- Fixed the production smoke runner to load TanStack/Nitro's `.output` bundle.

## Verified functional contracts

The automated suites cover Guest cart/checkout/order lifecycles, booking state,
payment attempts, receipt and journal idempotency, POS settlement, Kitchen/Bar/
Pastry routing, delivery, station/store consumption routing, procurement,
Finance posting, folio projection, permission boundaries, tenant/property
scoping, audit contracts and responsive/accessibility behavior.

This is code-level verification, not a claim that external providers, physical
devices, real cash counts or the deployed production database have been live-
certified from this runner.

## Non-blocking build warnings

- TanStack `createServerFn().inputValidator()` is deprecated and should be
  migrated to `.validator()` during a dependency-maintenance pass.
- The main client bundle (~662 kB), XLSX (~492 kB) and chart bundle (~368 kB)
  merit later lazy-loading/code-splitting work. The build still completes.
- The export had no Git metadata, so commit history and deployment revision
  cannot be reported from this package.

## Safe GitHub handoff

The packaged archive excludes `.env`, `node_modules`, `.output`, `.wrangler`
and other generated/private artifacts. Apply the Supabase migration before
deploying the matching frontend.
