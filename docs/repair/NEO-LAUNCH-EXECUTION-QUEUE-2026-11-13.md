# NEO active launch execution queue

Updated 2026-11-13. Local code repairs and isolated tests authorized; no deployment, credentials, migration execution or live payment/data actions.

This short actionable queue supplements the older 106-item acceptance queue. Its other items are not silently closed.

| ID | Priority | Area | Current state | Action / remaining work |
|---|---|---|---|---|
| LAUNCH-01 | P0 | POS M-Pesa entry | FIXED LOCALLY - tests/typecheck/build pass | Route that option into the shared actual prompt dialog and preserve entered amount; do not record a second generic payment |
| LAUNCH-02 | P0 | Provider readiness | FIXED LOCALLY - tests/typecheck/build pass | Fail closed in method selection and submit handlers; keep recorded cash independent |
| LAUNCH-03 | P0 | Existing Lovable relay / direct runtime key | LOCAL RELAY PREPARED - not enabled | Existing server now has a JWT-forwarding allowlist. Original handler/SQL/callback parity, deployment and authenticated sandbox acceptance remain required; payment forwarding stays separately off. |
| LAUNCH-04 | P0 | Receiving engine compatibility | QUEUED - local repair | Repair the accepted/rejected boundary using actual receiving-engine integration tests, preserve audit quantities and Finance effects |
| LAUNCH-05 | P1 | Recipe importer parity | BLOCKED - original backend/source | Obtain actual original importer source/RPC signature, compare then integrate without guessing or recreating data |
| LAUNCH-06 | P1 | Recipe activation integrity | QUEUED - local repair | Compare newer backend activation fix; specify and test atomic activation/binding without multiple active versions |
| LAUNCH-07 | P0 | Pending card/QR recovery | PARTIAL LOCAL REPAIR - duplicate guards tested | Repeat submissions now locked in the current dialog and property passed to intent. Atomic record/intent creation and recovery of existing stranded attempts remain open. |
| LAUNCH-08 | P1 | PIN and physical printing | LOCAL TESTS PASS - real device proof open | Horizon report confirms compatible PIN broker header. Verify real paired login; printing needs reachable privileged backend, matching connector protocol and physical printer. Only PDF/OneNote installed here. |
| LAUNCH-09 | P1 | Live updates and recipes baseline | PRESENT - workflow proof open | Run local recipe/access/refresh tests; preserve current speed; verify two-device propagation and reconnect |
| LAUNCH-10 | P0 | Departmental blueprint | BASELINE CHECKED - full/live acceptance open | Existing 20-chain matrix updated: 343 targeted tests pass, 23 live checks skipped, actual SQL fixtures pass 36/47/21 checks; receiving composition fails. |
| LAUNCH-11 | P1 | Source and schema synchronization | QUEUED - acceptance | Record exact commits/installed signatures; preserve dirty work; merge reviewed source through linked active branch; no blind pull or migration replay |
| LAUNCH-12 | P2 | Costs without stale operations | PRESENT - workflow proof open | Keep active update speed; optimize scoped/bounded reads and measured indexes only with latency checks; do not pause operational backend |

## Current evidence

- 18 POS payment-entry UI tests passed, including M-Pesa dispatch, readiness, cash, card-slip and bank-transfer cases.
- 75 POS/payment/finance/menu/printing/document checks passed across the expanded batch and document rerun. The document scan initially hit the default time limit; unchanged assertions passed on rerun.
- 54 recipe-engine/access/sheet and operational-refresh checks passed. Test batches overlap; do not add all historical batch totals.
- Production client/server build passed; synthetic server-key sentinel absent from 889 public files.
- Focused lint has zero errors and one pre-existing Fast Refresh warning. Full-project TypeScript check passed.
- No migration was executed, credential changed, deployment performed or real payment/data action taken. The existing KES 1802.50 attempt was not read or changed.

The JSON companion contains exact files, pass conditions and live dependencies. Fixed locally never means deployed or live-certified.

## 13 November existing-code follow-up

- Local public key: HTTP 200; local server key: HTTP 401 Invalid API key. Neither result establishes the Worker secret value. The production env file has no server key. No credential was printed or changed.
- Existing direct Supabase server code already supports service-role JWT and sb_secret_ keys. A separate bridge is optional when a valid original-project key can be provisioned.
- Current-dialog terminal/QR retries are locked before recording, including lost responses and missing tracking IDs. Intent opening now receives the order property. Closing is not cancellation; old pending attempts remain unresolved.
- M-Pesa rapid clicks are guarded synchronously. Rejected server credentials are tested to stop staff collection before pending creation or STK dispatch.
- Follow-up: 41 focused payment checks, lint, full-project TypeScript and production build passed; secret absent from 889 public files. No deployment, migration execution, credential change or live payment action.

- Read-only Cloudflare CLI secret list confirms all three existing Worker secret names: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY. Secret values were not retrieved or changed; existence does not prove validity.

- User confirmed deployed neo-preview Test Connection reports Supabase / Invalid API key. This is user-supplied live evidence, separate from the directly reproduced local HTTP 401. No valid replacement credential has been located or provisioned.

## Optional relay progress

- Implemented in the existing `src/server.ts`; tests extend the existing response-policy suite. No new source/report files or shared password.
- Matches existing original production IDs, carries caller JWT, preserves server-function serialization, restricts destination/origin/method/body, disables caching and never retries uncertain dispatch. Original backend still validates the session, tenant and permissions.
- Connection/settings relay and money-changing relay have separate off-by-default server switches. Neither was enabled or deployed. PIN/print, Vite development IDs and guest folio/deposit remain outside this relay.
- 57 focused tests, lint, full TypeScript and final relay production build passed; synthetic secret absent from 889 public files. See the existing backend contract for exact flags, limitations, prerequisites and rollback.

## Horizon report and targeted PIN/printing/STK verification

- Supplied Horizon report confirms the two new atomic M-Pesa start/dispatch routines are absent from the shared database. The existing apply routine alone does not provide those start/dispatch guarantees. Keep the money relay disabled.
- Reported PIN architecture is an app server route accepting X-Neo-Device-Token, matching this checkout proxy. The local Deno Edge file is not reported deployed and is not required for that broker path. PIN transport now rejects redirects; behavioral tests cover response/denial/failure handling. Real paired-device sign-in remains untested.
- Local Node print agent and scoped API/database tests pass, including claim ownership, retries and uncertain outcomes. The separate local PowerShell PrintEngine is a manual utility, not a demonstrated connection to the shared application queue. Only virtual Windows printers were found; no physical paper output is certified.
- User says no Horizon repository is available. Its reported commit is absent locally and its reported branch is absent from this checkout remote. Do not assume source parity or overwrite local repairs.
- STK TransactionDesc now obeys the supplied 13-character limit. Accepted responses missing a checkout reference stay uncertain, without an automatic second request. Callback/amount/password/phone/endpoint assertions pass in fixtures.
- 103 focused tests and 15 Node print-agent tests passed. Lint and final full-project TypeScript passed. These are isolated tests, not complete departmental/live acceptance. No new source/report files were created.

## Current priority pass: M-Pesa, then departmental blueprint

- M-Pesa: rejected gateway access is checked before guest balance reservation; early callbacks remain visible for provider-verified recovery, with HTTP 503 requesting rather than guaranteeing a provider retry.
- Legacy raw-callback replay was a verified unsafe route. The existing candidate SQL disables it and removes browser execution; UI now checks Safaricom through existing server reconciliation, and its obsolete manifest entry is removed. SQL installation must precede matching handlers; it was not executed here. Old unresolved callback audit rows are retained and are not falsely marked resolved merely because a status check ran.
- Payment batch: 131 passed; focused final callback/SQL rerun: 25 passed (overlap); RPC guard/manifest checks: 13 passed. Lint, full TypeScript and final frozen-source production build passed. Built fingerprint matches current source, obsolete replay is absent, and synthetic key is absent from 889 public files.
- Departmental matrix: 20 chains updated in the existing readiness report. Two batches: 209 and 134 passed; 18 inventory and 5 GRN/Finance live checks skipped without an authorized PostgreSQL connection. Actual SQL fixture checks: room charge 36, readiness 47, event ownership 21.
- Receiving remains a confirmed failure at the real-engine boundary, even though the substituted-engine review tests pass. No end-to-end supplier/stock/Finance success is claimed.
- No Lovable prompt was sent. User directed codebase-only verification; no backend installation, deployment, credential change, real payment or operational record mutation occurred.
