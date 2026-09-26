# NEØ production-readiness audit — 23 September 2026

## Scope

Audited source: `neo-codebase-corrected-2026-09-23(1).zip`.

This review treats the exported repository as an independent application: source code, TanStack Start server runtime, Supabase database history, authentication, provider secrets, callbacks, CI/build tooling, and production-origin configuration were inspected separately.

## Baseline found in the export

The original export contains approximately:

- 1,246 TypeScript/TSX source files
- 391 route files
- 257 test/spec files
- 977 Supabase SQL migrations
- TanStack Start + React + Vite runtime
- Supabase browser/auth/admin layers
- server-side payment, delivery, M-Pesa, communication and AI-provider integrations
- CI/build-smoke/diagnostic scripts
- a prior `CODEBASE_CERTIFICATION_CHECKPOINT.md` recording a successful production build, SSR smoke, TypeScript pass, and thousands of passing automated tests

This is an application repository, not a static Lovable-only frontend export.

## What this audit verified

- No real secret values were found hard-coded in the source reviewed; runtime code references environment-variable names.
- The normal browser Supabase client uses the public/publishable credential; privileged Supabase access is implemented in server-side paths.
- The service-role key is not intentionally exposed through a `VITE_*` variable.
- The project carries both npm and Bun lockfiles, and the Lovable TanStack Vite package resolves from the public npm registry.
- The Supabase migration set has 977 SQL migration files; deployment must compare remote migration history rather than replaying the folder blindly.
- The public origin had several Lovable-specific references that needed to be made deployment-aware.
- Generic payment/delivery gateway configuration had a production security boundary that needed hardening (see below).

## Production security issue found and patched in this handoff copy

### Generic connector environment-variable lookup

The exported generic payment and delivery gateway paths accepted a tenant-configured `secret_name` and then resolved `process.env[secretName]`. Because connector configuration is workspace-managed, that was broader authority than a tenant configuration should have on a shared production host.

The handoff copy now restricts generic connector secrets to the dedicated namespace:

`NEO_CONNECTOR_*`

For example:

`NEO_CONNECTOR_CARD_TERMINAL_API_KEY`

The server refuses names such as `SUPABASE_SERVICE_ROLE_KEY` or `OPENAI_API_KEY`, the Integration Centre validates the same rule, and a regression test was added. This change does not alter PMS/POS/Finance/Inventory/HR business workflows; it narrows secret access for generic connectors.

## Deployment-boundary changes made

- Hardened `.gitignore` for `.env*`/`.dev.vars*` secrets while retaining `.env.example`.
- Added `.env.example` describing browser-safe, server-only, public-origin and optional provider variables.
- Added `.nvmrc` for Node 22.
- Added `typecheck`, `verify`, and `secret-scan` scripts.
- Added a GitHub offline production-gate workflow plus a separate manually-triggered live-environment certification workflow.
- Added a client-bundle secret sentinel scan for the release pipeline.
- Made canonical/social URL generation configurable through `VITE_PUBLIC_SITE_URL` while retaining the current Lovable URL as the transition fallback until cutover.
- Removed the old Lovable sitemap URL from the static `robots.txt`; add the final absolute sitemap URL once the permanent domain is known.
- Changed the repository auth-email image source from a Lovable asset URL to `{{ .SiteURL }}/neo-splash-mark.png`; Supabase Auth Site URL therefore needs to be changed at cutover.
- Added this audit report and `PRODUCTION_HANDOFF.md`.

No business-module rewrite or framework migration was performed.

## Verification limitation in this audit environment

A clean `npm ci` was attempted against the extracted export. The runner could not resolve `registry.npmjs.org` (`EAI_AGAIN` DNS/network failure), so dependencies could not be freshly downloaded here and the modified handoff copy could not be rebuilt/tested in this runner.

That is an audit-environment limitation, not a discovered NEØ compile failure. The original repository's included certification records a successful production build/typecheck/smoke/test pass before these small deployment-boundary changes.

**Therefore the handoff copy must pass the added production gate on a networked machine/GitHub before production cutover.**

## Required gates before production cutover

1. Push this handoff copy to a private GitHub repository with no real `.env` file committed.
2. Let GitHub install dependencies and run the offline production gate. Configure the protected `production-readiness` GitHub Environment later and run the live-environment gate with read-only database credentials before cutover.
3. Create/use a staging Supabase environment for the first local/deployed verification; do not perform ordinary local testing with the live service-role key.
4. Compare the target production project's Supabase migration history and run a migration dry-run before applying anything.
5. Confirm a recoverable database backup/PITR policy before schema changes.
6. Choose the final host and domain, then configure all runtime variables/secrets there.
7. Set `VITE_PUBLIC_SITE_URL`, `PUBLIC_SITE_URL`, and `SITE_URL` to the final HTTPS origin.
8. Update Supabase Auth Site URL/redirect allow-list and publish the auth-email template for the final host.
9. Change live provider callback URLs only after the final public HTTPS hostname is serving the release.
10. Run the end-to-end production release gate in `PRODUCTION_HANDOFF.md`, including accounting reconciliation and tenant/property isolation.
11. Keep the existing Lovable deployment available for rollback until the new release passes.

## Product boundaries that are not migration failures

The existing codebase audit documents that core hospitality workflows are much more complete than some hardware/third-party edge integrations. In particular, browser/PDF printing exists, while generic direct USB/LAN/Bluetooth printer discovery/routing is not implemented as a complete hardware bridge. Those items should not be confused with functionality lost by moving the application to localhost/GitHub.

## Audit conclusion

The source export is structurally suitable for an independent production deployment, but the safe cutover is a controlled release, not “upload zip and point DNS.” The code, database, secrets, auth URLs, external callbacks and host runtime must be moved in that order and verified independently.
