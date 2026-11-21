# Rejected local server credential: verified execution route

16 November 2026. This investigation made no credential/permission changes, database writes, deployments, print claims or payment requests. It preserves the existing managed database.

## What was checked

| Check | Actual result | What it establishes |
| --- | --- | --- |
| Local public/server project URLs | Same configured URL | No frontend/server project-URL mismatch was found |
| Public-key GET `/auth/v1/settings` | HTTP 200 | The public API credential and this read-only service work; the whole backend is not demonstrated broken |
| Independent service-role lookup of active printers | Invalid API key, including with the app's opaque-key header handling | The local privileged connection is unusable; this does not establish staff-role access or database corruption |
| Server credential structural inspection | Neither `sb_secret_…` nor a three-part legacy JWT; no Bearer prefix/whitespace; matches `.env.local` | Its exact cause/provenance is unverified. No value or key fragment was printed; do not assume a valid managed key can be recovered from it |
| Managed print endpoint, no token | HTTP 401 JSON unauthorized | The original managed route responds |
| Managed print endpoint, deliberately unregistered `neopc_` token, printer-list only | HTTP 401 JSON unauthorized | The managed route refuses that agent; valid agent success and installed SQL parity remain unproved |
| Independent print endpoint, same unregistered token | HTTP 500 JSON server_error | Consistent with its unavailable privileged execution path; do not treat a saved printer IP as an operational agent |
| Lovable connector identity/workspace calls | Internal errors | Direct connector-driven installed-definition inspection could not proceed; this is separate from the application's public API credential |

The public Auth-settings test did not sign in or expose account settings in the recorded output. Endpoint probes used only empty bodies and an unregistered token on the printer-list action, never claim/finish/discovery writes.

## Repair implemented locally

`src/lib/managed-print-relay.ts`, invoked before the local router in `src/server.ts`, supports the existing five print-agent actions: printers, claim, finish, discovery and discovered. It forwards only to `https://horizon-prime-os.lovable.app/api/public/print-agent/{action}` using the existing agent token. The managed handler remains responsible for validating that token, revocation, property scope and claim identity. The managed service-role key stays in that runtime.

The independent server no longer needs its local service key for those actions **when** `NEO_MANAGED_PRINT_ENABLED=true` is configured in the deployed runtime. The default is off. No flag was enabled in this investigation. This is a print-specific route, independent of M-Pesa collection/callback flags; no payment gate was changed.

The relay rejects unknown actions, query-based destinations, staff JWTs in place of agent credentials, malformed/oversized requests, redirects, HTML shells and invalid success envelopes. It strips browser cookies and API-key headers; it forwards only the established action fields. A timeout/error never triggers another claim, local database execution or a second printer send. Existing agent delivery journals and claim-expiry recovery remain authoritative. Output is private/no-store and logs contain no token or raw upstream exception.

The compiled-app check caught an adapter detail missed by the first unit run: Nitro invokes the SSR service with only the request and attaches Cloudflare bindings to `request.runtime.cloudflare.env`. Reading only the server entry's second argument missed the flag and fell through to local execution. The relay now reads that request-local binding, with explicit runtime/process configuration fallbacks, and never uses the shared global `__env__`. A server-entry regression covers the missing-second-argument path.

Paired agents can retain the independent application's existing URL after this route is deployed; no new agent password, database key or financial API is introduced. The pre-existing original managed endpoint must still match the installed print contract before activation.

## What does not require this server key

- Canonical document/report PDF functions use `requireSupabaseAuth` and the caller's scoped database client. Their generated files are not repaired by adding admin privileges.
- Procurement, stores, minibar and Front Office user commands use authenticated RPCs. Their UI acceptance requires a real authorised user session, not a replacement service key.
- Installing/checking SQL definitions requires authorised access through the original managed project. The currently failing Lovable connector cannot be replaced by an unauthenticated SQL proxy.
- Payment, PIN and provider callbacks have separate reviewed contracts. Do not route them through the print relay or enable unrelated flags to cure printing.

## Release/verification queue

1. Verify original managed print routines, owners/grants, token hashing, property/station scope, claim/finish response shapes and uncertain-delivery behavior through the original project. The unauthorised probe is not that proof.
2. Release the reviewed Worker source with existing runtime variables preserved and this print-only routing flag enabled; avoid deploying unrelated unreviewed concurrent finance changes.
3. Test the existing paired agent's **printer list first**, then discovery, then one controlled labelled test job. Record job/claim/outcome and physical paper; preserve the existing printer/agent identities.
4. Test expired/revoked/wrong-property tokens, offline/unknown delivery, finish acknowledgement retry and no duplicate output.
5. Continue ordinary authenticated document/procurement/PMS acceptance independently; retain installation and physical-device gaps as separate queue items.

No deployment/activation or real paired-agent success is claimed here. Current checks are recorded in `ACTIVE-EXECUTION-QUEUE.md`.

Local regression: **98 passed across five suites** for managed printing, server entry, existing PostgreSQL print protocol, cache/M-Pesa relay and callback boundaries. Two concurrent deposit suites passed **23 checks** after five test-only non-null array-index corrections; no deposit financial code was changed.

Corrected production build passed. Updated built-server smoke passed managed printing using request-local bindings with a mocked upstream, plus `/` and `/auth`. A separate probe invoked the **compiled Worker** with only `NEO_MANAGED_PRINT_ENABLED=true`, no local database credential and an unregistered token, and reached the **real managed printer-list endpoint**: HTTP 401 `managed_print_request_rejected`, rather than local privileged execution/HTTP 500. This establishes working compiled transport and upstream rejection, not successful authentication of a real agent or a physical print. No runtime setting was changed on the deployed Worker.

Final full-project TypeScript check passed after these changes.

Platform context: Supabase documents that [Lovable Cloud manages its underlying project and does not expose its service/API keys](https://supabase.com/kb/troubleshooting/cant-access-supabase-project-lovable-cloud). That supports keeping privileged execution in the authorised managed runtime rather than exporting its key or changing RLS.
