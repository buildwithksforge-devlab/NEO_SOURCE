# M-Pesa Daraja security audit

**Follow-up:** additional local duplicate-dispatch, amount, status-query and UI corrections are recorded in [Payment reality check](PAYMENT-REALITY-CHECK-2026-11-12.md), under "M-Pesa completion pass". They require the new `20261112150000` migration and matching app deployment. The production-readiness limitation below still applies.

**Audit date:** 12 November 2026  
**Repository branch:** `repair/neo-waves-20261106`  
**Scope:** Local source, migrations, tests, and existing repair evidence. No live credentials were read, logged, copied, or changed. No live callback token was rotated; no deployment, production migration, or real-money transaction was performed.

## Executive assessment

**Production readiness: NO — not established.** The current local source has effective server-side credential boundaries and tenant-scoped settings/payment operations. This audit confirmed payment-integrity, callback-secret handling, provider-dispatch, and environment-isolation gaps, then added local corrections and regression tests. Those changes are not deployed. Credential fields remain plaintext database `text` columns in the repository schema, and managed-database/backup encryption and key controls could not be verified from this repository. Real Daraja authentication, STK Push, callback, settlement, and reconciliation were not executed.

The user supplied Safaricom integration guidance confirming that the production Consumer Key/Secret and Lipa na M-PESA Passkey are obtained in the Safaricom app portal and that the STK password is Base64 of shortcode + passkey + timestamp. The implementation uses the same server-side OAuth endpoint, environment-specific Daraja hosts, and STK password construction. No actual credential values were requested or used.

## A. Audit findings

| ID | Severity | Status | Evidence and impact | Correction / remaining action |
|---|---|---|---|---|
| MP-01 | HIGH | **Open operational requirement** | The `consumer_key`, `consumer_secret`, and `passkey` fields are ordinary `text` columns in [`20260823162435_2ea97ffd-d21c-49a0-86be-5b77c4aedf65.sql`](../../supabase/migrations/20260823162435_2ea97ffd-d21c-49a0-86be-5b77c4aedf65.sql). The settings table is granted to `service_role`, and app reads use the server-only [`mpesa.server.ts`](../../src/lib/mpesa.server.ts), but application-level authenticated encryption and an external key manager are not present in the inspected code. A database/service-role or backup compromise could expose stored provider credentials. | Do not enable production until the deployment owner confirms database and backup encryption and a separately managed key. If application-level encryption is required, design and approve key management before migration; no credentials were migrated or discarded. |
| MP-02 | HIGH | **Fixed locally; deployment and provider verification pending** | The callback previously treated a matching callback-token URL and checkout ID as sufficient evidence and passed the callback's result code directly to payment posting in [`mpesa.callback.$token.ts`](../../src/routes/api/public/mpesa.callback.$token.ts). A leaked bearer callback URL could therefore permit a forged status claim. | The callback now queries Daraja server-side and checks result code, checkout/merchant identifiers, and successful callback amount against the transaction before applying. Local mocked tests cover match, mismatch, and unavailable-query behavior. Live Daraja query behavior remains unverified. |
| MP-03 | MEDIUM | **Fixed locally; deployment pending** | `neo_guest_deposit_pay` previously inserted a new transaction for each repeat request. Separate successful prompts could over-credit a reservation deposit; the old callback guard only prevented duplicate application of the same transaction. Evidence: prior implementation in [`20260908114430_467a5526-6abe-444e-996f-c064f6d7295a.sql`](../../supabase/migrations/20260908114430_467a5526-6abe-444e-996f-c064f6d7295a.sql) and result application in [`20260914114337_e10b0103-e654-4a88-9034-5e11993a2889.sql`](../../supabase/migrations/20260914114337_e10b0103-e654-4a88-9034-5e11993a2889.sql). | The new migration locks the reservation, reuses active prompts, and declines to dispatch a second STK for a reused transaction. A before-insert guard caps an accepted deposit to the remaining required amount and records any excess in `mpesa_deposit_exceptions` with `refund_required` status. There is no automated refund execution or user-facing exception-resolution screen; Finance must review and resolve those records. |
| MP-04 | MEDIUM | **Fixed locally; deployment pending** | One `mpesa_settings` row per organization stored credentials across environment changes. The previous save routine retained old secrets when fields were left blank, so changing sandbox/production could reuse credentials against the other environment. | The new save routine blocks environment changes while prompts are active and requires all three credentials to be re-entered for the selected environment. The data model still supports one active environment/configuration per organization, not concurrent sandbox and production configurations. |
| MP-05 | MEDIUM | **Not verified** | Callback-token rotation replaces the single active token. A callback arriving on the old URL is rejected. Existing transactions with checkout IDs can be recovered through the authenticated status-query/reconciliation flow, but dual-token overlap was not found. | Do not rotate a live token during this audit. Before an operational rotation, reconcile outstanding prompts and confirm the status-query recovery procedure. A grace-period token mechanism would require a separately reviewed change. |
| MP-06 | LOW | **Not verified** | Production TLS termination, HSTS/CSP, server access-log treatment of callback URL paths, and managed-database/backup controls are outside the local repository evidence. The app validates configured callback bases as HTTPS in [`mpesa-callback.ts`](../../src/lib/mpesa-callback.ts); Daraja endpoints in [`mpesa.server.ts`](../../src/lib/mpesa.server.ts) use HTTPS. | Verify deployment controls with the operator; no live service configuration was inspected or modified. |
| MP-07 | MEDIUM | **Fixed locally; migration and deployment pending** | Successful STK request metadata previously included the callback URL containing its bearer token, and provider error bodies were returned in server results. The URL token could leak through persisted diagnostics or authorized error surfaces. | Daraja diagnostics now redact both the STK password and callback URL and no longer echo provider response bodies. The guest-deposit migration redacts historical callback URLs in stored request metadata. |
| MP-08 | HIGH | **Fixed locally; migration and deployment pending** | Integrated card/QR payment dispatch could race before an intent was marked sent, allowing concurrent calls to issue duplicate provider requests. Open payment intents also retained callback tokens in plaintext. Evidence and correction are in [`payment-gateway.functions.ts`](../../src/lib/payment-gateway.functions.ts), [`payment-intents.ts`](../../src/lib/payment-intents.ts), and [`20261112140000_provider_payment_dispatch_safety.sql`](../../supabase/migrations/20261112140000_provider_payment_dispatch_safety.sql). | Callback tokens are stored as hashes and a transactional one-time claim gates provider dispatch. Local tests cover the claim and callback matching contract. No external provider dispatch was attempted. |
| MP-09 | MEDIUM | **Fixed locally; deployment pending** | An STK request whose connection was lost could be treated as definitively failed even though Safaricom might have received it; retrying could create a second prompt/payment attempt. | Transport loss and unreadable successful HTTP responses are now marked ambiguous, provider error details are sanitized, and the prompt UI tells staff to check Recent collections before retrying. This reduces unsafe retries but does not guarantee recovery when no checkout ID was returned. |
| MP-10 | LOW | **Fixed locally; deployment pending** | The connection test only used saved credentials, forcing operators to save a replacement before testing it and potentially disrupting a known-good configuration. | The test now accepts typed, unsaved Consumer Key/Secret drafts without saving them or marking a different saved environment verified. Source inspection confirms the draft path avoids the save RPC; live OAuth remains untested. |

### Credential exposure and authorization evidence

| Check | Result | Evidence |
|---|---|---|
| Browser bundle/public env contains M-Pesa credentials | **PASS, source/static scan** | Credential inputs are posted to server functions in [`mpesa.functions.ts`](../../src/lib/mpesa.functions.ts); no M-Pesa credential values are configured through public `VITE_*` variables in the inspected sources. `npm run secret-scan` passed with a synthetic sentinel: not found in 889 public build files. |
| Secret values returned by settings API | **PASS, source inspection** | `neo_mpesa_settings_get` returns presence booleans (`has_consumer_key`, `has_consumer_secret`, `has_passkey`), not the values. It returns the callback token for the authorized admin callback URL display; that token is a separate bearer secret, not a Daraja credential. |
| Masked inputs are placeholders, not read-back values | **PASS, source inspection** | Password inputs are local React state, use masked placeholders, and are cleared after successful save in [`admin.payments-mpesa.tsx`](../../src/routes/admin.payments-mpesa.tsx). |
| localStorage/sessionStorage/telemetry exposure | **PASS for inspected M-Pesa paths; broader browser/XSS posture not verified** | No M-Pesa credential persistence or credential logging was found in the settings UI, server functions, or Daraja client. |
| Authentication and tenant authorization | **PASS, source-level; live RLS not executed** | Server functions require a verified Bearer access token in [`auth-middleware.ts`](../../src/integrations/supabase/auth-middleware.ts). Settings RPCs resolve `current_org_id()` and require M-Pesa administrator permission. The settings table is service-role-only. Guest deposit initiation matches organization, reservation reference, and authenticated customer. Callback transaction lookup is scoped by token owner organization and checkout request ID. |
| HTTPS | **PASS in source; deployment TLS NOT VERIFIED** | Daraja sandbox/production endpoints are hard-coded HTTPS; configured callback base URLs reject non-HTTPS. The deployed endpoint's TLS, HSTS, and proxy behavior were not probed. |
| Secret replacement | **PASS in source; no live replacement performed** | Non-empty replacement values update the stored fields; omitted values preserve existing credentials. Environment changes now require all three new values. The test only uses synthetic strings. |
| Daraja password/token | **PASS in source; provider NOT RUN** | OAuth uses Basic Auth server-side; STK password is constructed server-side from shortcode, passkey, and timestamp. The token and passkey are not returned to browser functions. |
| Server-side authoritative payment amount | **PARTIAL / NOT VERIFIED** | Guest deposit amount is recomputed from reservation due in the database. POS/folio paths call module payment RPCs before STK, but live balance enforcement and bill/till allocation were not exercised in this audit. |
| Payment confirmation | **Fixed locally; live NOT VERIFIED** | Callback application now requires a Daraja status query match, but no real provider response was obtained. |
| Duplicate/replayed callbacks | **PASS, local contract/database tests** | `applied_at` is locked and checked in `neo_mpesa_apply_result`; repeats of an applied transaction are not posted again. Guest excess handling is covered by PGlite tests. Live replay was not attempted. |
| `pos_payments_external_ref_uidx` | **NOT VERIFIED operationally** | The local unique index is on organization/method/external reference; an M-Pesa receipt is used as the external reference. A same-receipt collision would fail rather than silently duplicate a posting, and callback apply failures are retryable. The previously reported split/top-up interaction and deployed data were not reproduced or modified. |
| XSS/CSRF/session hardening | **PARTIAL / NOT VERIFIED** | Server functions require a Bearer token and do not rely on cookie-only authentication, reducing classic CSRF exposure. A full XSS/CSP review and deployed session/storage configuration review were outside this payment-specific source check. |

## B. Changes and local verification

Changed/added for this audit:

- [`20261112130000_guest_mpesa_deposit_idempotency.sql`](../../supabase/migrations/20261112130000_guest_mpesa_deposit_idempotency.sql): environment-change guard; atomic guest-deposit prompt reuse; excess-payment quarantine schema and deposit cap trigger. **Local only; not applied to any database.**
- [`mpesa.functions.ts`](../../src/lib/mpesa.functions.ts): reused active guest-deposit prompt returns without dispatching another STK.
- [`mpesa.callback.$token.ts`](../../src/routes/api/public/mpesa.callback.$token.ts): Daraja STK query verification before applying a callback.
- [`guest-mpesa-deposit-idempotency.test.ts`](../../src/lib/__tests__/guest-mpesa-deposit-idempotency.test.ts): PGlite coverage for prompt reuse, terminal retry, remaining-balance cap, excess quarantine, tenant substitution, and environment switch safeguards.
- [`mpesa-callback-integration.test.ts`](../../src/lib/__tests__/mpesa-callback-integration.test.ts): callback verification, mismatched result, provider query outage, and cross-tenant transaction rejection.
- [`payment-gateway.functions.ts`](../../src/lib/payment-gateway.functions.ts) and [`payment-intents.ts`](../../src/lib/payment-intents.ts): atomic integrated card/QR dispatch and hashed callback-token verification.
- [`20261112140000_provider_payment_dispatch_safety.sql`](../../supabase/migrations/20261112140000_provider_payment_dispatch_safety.sql): local-only provider callback-token hashing and one-time dispatch claim.
- [`admin.payments-mpesa.tsx`](../../src/routes/admin.payments-mpesa.tsx): unsaved draft credential connection test.
- [`mpesa-server.test.ts`](../../src/lib/__tests__/mpesa-server.test.ts): Daraja request shape, secret redaction, and ambiguous network-loss coverage.

Validation:

- Focused payment regression suite: **31 passed across 5 files**.
- Typecheck: **PASS** (`npm run typecheck`).
- Client secret scan: **PASS**, synthetic sentinel not found in **889** public build files.
- Focused ESLint: **PASS** for payment files; `rpc-manifest.ts` retains four pre-existing `no-irregular-whitespace` findings in unrelated comments.
- `git diff --check`: **PASS**.
- No live credentials, provider requests, migrations, or financial writes were used.

## C. Multi-tenant isolation

| Test/check | Result | Evidence boundary |
|---|---|---|
| Settings are keyed by organization and resolved through authenticated `current_org_id()` | **PASS, source inspection** | Does not prove deployed grants/RLS configuration. |
| Guest attempts to use another organization's reservation reference | **PASS, PGlite negative test** | Synthetic local schema; not a deployed database/RLS test. |
| Valid Company A callback token cannot resolve Company B transaction | **PASS, callback integration negative test** | Mocked repository boundary; not a live tenant database test. |
| Company A cannot retrieve/replace/decrypt Company B's credentials | **PASS by source boundary; NOT VERIFIED against deployed RLS/service-role configuration** | Settings getter and saver derive organization from trusted auth context; no caller-supplied organization parameter exists. No credentials were queried. |
| Multiple shortcodes/tills per organization | **NOT VERIFIED / not supported as simultaneous settings** | `mpesa_settings` is keyed by organization, so the inspected integration provides one active shortcode/environment configuration per organization. |
| Transaction property/account/till assignment | **NOT RUN** | Requires live/sandbox end-to-end payment evidence. |

## D. Payment workflow verification

| Workflow | Result | Exact boundary |
|---|---|---|
| Save Company A credentials; confirm no browser readback | **PASS, source/static scan only** | No real credentials saved. |
| Secure credential replacement | **PASS, synthetic PGlite test** | Environment-switch guard exercised locally; no live configuration changed. |
| Daraja OAuth connection test | **NOT RUN** | No authorized sandbox credential or provider facility was supplied for this audit. |
| Sandbox STK initiation | **NOT RUN** | No sandbox STK request was sent. |
| Successful callback and posting | **PASS, mocked/local contract only** | Query and transaction matching logic tested with synthetic provider responses; no actual callback/provider receipt. |
| Failed/cancelled callback | **PASS, mocked/local contract only** | Cancellation status path tested; no provider transaction. |
| Timeout/delayed callback | **NOT RUN** | No external prompt was created. |
| Duplicate callback/retry | **PASS, local tests only** | Applied-state/idempotency and deposit cap tests; live replay not performed. |
| Integrated card/QR duplicate dispatch and callback token matching | **PASS, local test only** | Synthetic transactional claim/hash contract; no real provider request. |
| Callback re-application | **NOT RUN** | Existing admin recovery path inspected, but no persisted live callback was re-applied. |
| Cross-company isolation | **PASS, local negative tests** | Synthetic PGlite and mocked callback boundaries only. |
| POS/till allocation and `pos_payments_external_ref_uidx` collision | **NOT RUN** | No production payment mutation or duplicate receipt replay performed. |
| Cash/card-slip/bank-transfer tender recording | **NOT RUN** | These are recorded tenders rather than direct provider API calls in the inspected paths; no financial records were changed. |
| Hotel folio settlement | **NOT RUN** | No new folio transaction in this audit. |
| Restaurant/POS settlement | **NOT RUN** | No new sale or payment in this audit. |
| Cashier reconciliation/business closure | **NOT RUN** | No live financial records were changed. |

## E. Production readiness checklist

- [x] Browser-facing settings API does not return Consumer Key, Consumer Secret, or Passkey values.
- [x] Daraja auth and STK password construction are server-only in source.
- [x] Settings and callback lookups are scoped by authenticated organization/token.
- [x] Local fixes and focused regression tests added for callback verification and guest-deposit excess/retry behavior.
- [ ] Confirm deployed database and backup encryption; add separately managed application encryption if required.
- [ ] Apply and verify the local migration through the approved deployment process.
- [ ] Run authorized sandbox OAuth, STK, callback, duplicate, cancellation, timeout, and delayed-callback tests.
- [ ] Verify actual hotel folio and POS/till/accounting posting and cashier reconciliation.
- [ ] Establish an operator workflow and restricted review access for `mpesa_deposit_exceptions`; confirm refund execution/accounting.
- [ ] Confirm production TLS, access-log redaction for callback URL tokens, and deployment RLS/service-role grants.
- [ ] Reproduce or close the reported POS external-reference collision with authorized test data.

**Final status: NOT PRODUCTION READY.** The local code/test results do not prove deployed security, at-rest protection, live Daraja behavior, or financial end-to-end integrity.
