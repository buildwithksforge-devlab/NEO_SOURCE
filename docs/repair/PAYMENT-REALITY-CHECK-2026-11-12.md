# Payment implementation reality check — 12 November 2026

**Latest local follow-up:** repeat-dispatch and status-parsing corrections are now implemented locally; see the final section. Earlier findings below describe the initial review and are superseded where explicitly corrected. Nothing in this report establishes that Lovable's deployed server key is invalid; only the local key was tested.

**13 November existing-code follow-up:** the generic POS M-Pesa option now enters the actual STK dialog, readiness fails closed, and current-dialog terminal/QR duplicate submissions are locked through intent opening and uncertain failures. The order property is passed when opening an intent. M-Pesa rapid clicks are guarded synchronously. Forty-one focused payment tests and lint passed; the follow-up full TypeScript check passed. These changes are local and do not repair prior pending rows, provision a valid key, establish installed SQL parity or certify live payments. No new source/report files were added in this follow-up. See the existing active execution queue for build and runtime verification.

## Verdict

The earlier implementation work exists in commit `358686727474e15cd3e14d6c794a8d6c15ef4489`. It does **not** establish that deployed collections and confirmations work end to end. The existing security audit explicitly records no deployment, production migration, live OAuth, STK push, or settlement test.

A new read-only request reproduced **HTTP 401, Invalid API key** with the server key configured in `.env.local`. The browser key returned HTTP 200. Both requests selected zero organization rows; no credentials or database records were printed. This establishes a local server configuration failure against the configured remote database. It does not establish the environment variables used by the published site.

## What the buttons actually do

| Action | Actual path | What it proves / current limit |
|---|---|---|
| Test connection | `admin.payments-mpesa.tsx` → `testMpesaConnection` → authorized settings RPC → server credential load → `darajaToken` → Daraja OAuth | Tests Consumer Key/Secret authentication only. It does not test shortcode/passkey, STK delivery, callback reachability, or payment posting. Credential loading uses the rejected server key in this local configuration. Draft tests also execute that saved-credential load first. |
| Refresh recent collections | `transactions.refetch()` → Supabase `mpesa_transactions` read | Reloads stored transactions; does not ask Safaricom about a payment. |
| Refresh callback failures | `failedCallbacks.refetch()` → Supabase `mpesa_callback_events` read | Reloads stored failures; does not retry or reconcile them. |
| Send prompt, staff POS/folio | `MpesaPromptDialog` → `chargeWithMpesa` → credential load → module payment RPC → transaction RPC → Daraja STK push | Actual provider request exists in source. Server credential loading is blocked by the rejected local server key. No real prompt was sent during this check. |
| Send prompt, guest delivery/folio/deposit | Dedicated `charge*WithMpesa` server functions → module start RPC → Daraja STK push | Implemented paths exist. Some create a pending database record before loading credentials, so a server credential-load exception can leave a pending attempt needing inspection. Not tested against guest accounts or a live provider. |
| Check status / reconcile | `reconcileMpesaTransaction` → tenant-visible transaction → permission check → server credentials → Daraja STK query → `neo_mpesa_apply_result` | Can update financial state after querying the provider. Deliberately not invoked in this read-only check. |
| Provider confirmation | token callback route → transaction lookup → Daraja status verification → `neo_mpesa_apply_result` | Verification and posting logic exists, covered by mocked tests. Server key failure blocks trusted database access locally. Public callback reachability and deployed posting were not verified. |
| Retry failed callback | `neo_mpesa_retry_callback` RPC | Attempts to apply an existing callback; distinct from refreshing the failure list. Not invoked. |
| Integrated card/QR | `payment-gateway.functions.ts` → dispatch claim → configured provider endpoint → callback | One-time dispatch claim and hashed tokens exist in source/migration. No provider endpoint or deployed claim routine was exercised. |
| Cash/card slip/bank transfer | Recorded-tender workflows | These do not establish a provider API payment. No financial records were created or confirmed in this check. |

## Remaining source findings

1. **Guest folio can dispatch again for a reused transaction.** `neo_guest_folio_mpesa_start` reuses an active payment/transaction, but returns no `reused` dispatch indicator. `chargeGuestFolioWithMpesa` calls `stkPush` for that returned transaction unconditionally. The new guest-deposit reuse guard does not cover this folio path.
2. **POS/staff folio retries use a new reference.** `chargeWithMpesa` creates a new random `providerReference` per invocation. Its idempotency keys therefore do not, by themselves, deduplicate separate clicks or dialog reopenings. Module database balance/pending guards must be verified before claiming cross-request duplicate protection. The new card/QR dispatch claim is not used for M-Pesa.
3. **Uncertain outcome can display a success message.** `MpesaPromptDialog` says “Prompt sent to the customer's phone” for any `ok` result with a transaction ID, including `status: unknown`. The warning later shown does not make this initial success message reliable evidence of phone delivery.
4. **Missing provider reference is described too strongly.** Reconciliation says a prompt “never reached Safaricom” when no checkout ID exists. A transport failure can leave the provider outcome uncertain; absence of a saved ID does not prove no prompt was sent.
5. **Production-ready badge is configuration based.** `getMpesaSettings` derives it from stored credentials, previous OAuth status, environment, enabled flag, and callback hostname. It is not proof of a successful prompt, reachable callback, receipt, or balanced ledger.

These findings are from source inspection, not observed live financial incidents. This review intentionally made no application or migration changes.

## New verification evidence

- `node scripts/payment-api-readonly-check.mjs`: browser HTTP **200**, zero rows; server HTTP **401**, `invalidApiKey: true`.
- Focused Vitest run: **31/31 tests passed across 5 files** (`mpesa-server`, `mpesa-callback-integration`, `guest-mpesa-deposit-idempotency`, `payment-gateway-dispatch-safety`, `payment-intents-contract`). Provider tests use mocked responses; database tests use local PGlite.
- Initial sandbox network probes failed with `EACCES`; the read-only API probe was rerun with approved network access. Initial test bundling was blocked by filesystem restrictions; the same local tests passed with approved access.
- npm/npx entrypoints were blocked by the workstation's NVM trust check. Tests were run through the installed Vitest JavaScript entrypoint without changing NVM settings.
- A separate TypeScript check produced no diagnostic output and was stopped after the focused verification; this review does not claim a fresh completed typecheck.
- No keys, callback tokens, or provider response bodies were written to this report. No payment, credential replacement, callback retry, migration, deployment, or financial write was performed.

## Required before declaring payments operational

1. Replace the rejected server database key through the project's approved server-secret configuration, using a valid key belonging to this Supabase project. Verify the deployed server environment separately. Do not put it in a `VITE_*` variable.
2. Verify the new migrations are installed in the target database and the corresponding server/client build is deployed. Local files and commits do not prove either.
3. Resolve the repeat-dispatch and misleading-status findings above.
4. Run an authenticated sandbox acceptance flow for each collection surface: OAuth → one STK request → customer/sandbox result → verified callback or status query → one confirmed payment → matching balance/receipt/ledger. Include duplicate clicks, reopen/retry, cancellation, timeout, callback replay, delayed callback, and transport loss.
5. Check recorded tenders and integrated card/QR separately with their own configured workflows. Until that evidence exists, payment initiation through confirmation remains **not verified end to end**.

## Follow-up: owner intervention versus engineering work

Rechecked on 12 November: HEAD is still `3586867`; no later committed fix is present. The zero-row API check still returns browser HTTP 200 and server HTTP 401 / Invalid API key. This is a Supabase server key failure, not evidence that the Safaricom Consumer Key is invalid. Recorded cash, ordinary card-slip and bank-transfer paths do not require Daraja credentials; they still require application/database authorization and successful posting.

Additional local recorded-payment verification: **71 tests passed across 4 files** (`pos-payment-tender`, `payment-register-boundaries`, `pms-payment-dialog-recovery`, `deposit-receipt-journal-detail`). This includes stable cash collection-key reuse through failure/retry/reopening. It does not certify deployed cash/card/bank end-to-end acceptance.

M-Pesa request wiring exists: OAuth GET `/oauth/v1/generate?grant_type=client_credentials`, STK POST `/mpesa/stkpush/v1/processrequest`, status POST `/mpesa/stkpushquery/v1/query`, and incoming POST `/api/public/mpesa/callback/$token`. The incoming route is registered in `routeTree.gen.ts`. These are source checks, not proof that the configured public callback is reachable on the deployed build.

Owner/account or physical input still needed:

- Valid Supabase server-secret provisioning, or authenticated account access through which it can be configured. Do not paste the key into chat. Production environment parity also needs checking.
- Daraja sandbox/production account configuration and a controlled test handset/customer approval for provider acceptance. Current credential completeness could not be established through the rejected server key. Integrated card/QR acquirer details are needed only if those integrations are intended.
- Physical issuing-store decisions for Taveta Coffee Station, Salad / Cold Larder and Pastry. Latest saved evidence shows four other stations mapped; do not revert to the older zero-ready snapshot.
- Pair/run the property print/discovery agent and verify actual printer output and real-device installation behavior.
- Actual stock/delivery facts for unresolved negative Rice stock and supplier receiving. Software cannot establish goods receipt or physical counts from code.
- Intended manager identities/authority and a safe operational test boundary for approval, refund/payout, till, shift and business-day closure. Existing live manager denial is an engineering/access mismatch to investigate, not a reason to bypass permissions.
- Email sender/domain or provider account access and a test inbox for delivery proof if not already configured. Empty local Resend configuration does not establish the deployed email or Supabase Auth sender configuration.

Engineering work does not require the owner to debug it: remaining prompt deduplication/status messaging, deployment and migration parity checks, manager access mismatch diagnosis, delivery cold-navigation stall, receipt traceability installation, pricing/discount/currency/receipt/reporting checks, and end-to-end workflow evidence. These remain engineering tasks, with external access or physical facts requested only where necessary.

The saved global queue tracks 106 issues: 2 verified closed, 104 still carrying some repair or acceptance work (44 awaiting workflow tests, 39 in progress, 14 queued, 5 awaiting deployment/retest, 1 awaiting agent deployment, 1 partially verified). This is the recorded queue, not 104 freshly reproduced defects or 104 tasks requiring owner intervention. The specific missing delivery M-Pesa Till-claim queue function is recorded as repaired and verified; the full STK collection chain remains separate and unverified.

## Local fixes and key recovery follow-up

Implemented after the initial read-only review:

- Complete draft Consumer Key/Secret tests now skip privileged saved-credential loading. The authenticated administrator check remains in place, and a draft test never records the saved configuration as verified. Saved-credential tests still require the server key.
- Credential loading now identifies a Supabase "Invalid API key" error as a server database-key configuration problem, explicitly distinguishing it from Daraja credentials.
- Uncertain STK outcomes now show a warning instead of claiming a prompt reached the customer's phone. Accepted requests are described as awaiting customer confirmation.
- Missing checkout references no longer assert that the request never reached Safaricom.

Validation: connection/provider/callback/deposit/dispatch contract batch **36 passed**; subsequent connection/server/cash/POS tender/void/draft-removal batch **117 passed** (overlapping batches, not additive). TypeScript and focused ESLint passed. `git diff --check` passed. No provider request or real payment was made. These changes are local and uncommitted; they are not a deployed fix. Repeat-dispatch findings remain open.

PowerShell recovery checks found no valid server-key replacement in the current env files, the original `NEO_SOURCE.zip` env, generated Worker configuration, or process/user/machine environment. The backup contains the same rejected value; generated Worker config contains no Supabase runtime variables. No Supabase CLI access token was present in the checked standard file/environment locations. The configured value is neither a recognized server key nor a Supabase management token. No `.env.local` value was changed.

An attempted browser recovery was blocked by automatic approval review because available selected windows were Gmail/GitHub rather than a Supabase session. The user then directed this work to remain in PowerShell/code; browser recovery was stopped. A working privileged key for the existing remote Supabase project cannot be minted from this repository or replaced with the browser's public key.

Draft order removal uses authenticated `neo_pos_remove_draft` through the browser Supabase client, checks the returned order ID/cancelled state, and retains audit history. It does not use the Daraja integration or privileged server key. Its four local tests passed; this does not prove deployment parity or authorize removing a real order. Sent orders remain subject to the void/approval workflow.

## M-Pesa completion pass: local implementation

The new forward migration `20261112150000_mpesa_collection_dispatch_guard.sql` adds:

- `neo_mpesa_collection_start`: locks the underlying POS bill or folio and atomically creates its pending payment and M-Pesa transaction, or returns the existing active/uncertain transaction. Staff and guest folio paths share the same outstanding-attempt boundary. Existing payment engines continue to enforce their rules; the wrapper additionally checks property/guest ownership, KES currency, whole amounts and folio pending headroom. Transaction-creation failure rolls the new payment back.
- `neo_mpesa_guest_deposit_start`: reuses active and uncertain guest deposit attempts under the reservation lock, including the previously missed `unknown` state.
- `neo_mpesa_claim_dispatch`: a service-role-only one-time database claim before any STK dispatch. Repeated or unavailable claims send no prompt. Pre-migration in-flight attempts are marked as previously claimed to avoid automatically resending them. They must be reconciled, not blindly restarted.

All four outgoing M-Pesa handler paths now claim dispatch. Staff/guest folio and guest deposit reuse responses never call STK. Delivery's existing pending-balance guard remains in use and its message now distinguishes a pending collection from no balance. Successful provider responses are recorded only while `applied_at` is null, preventing a late dispatch response from overwriting an already-applied callback. Tracking-write failure produces an uncertain outcome and a no-retry warning.

Additional corrections: reject malformed Kenyan mobile numbers; reject fractional/non-positive/non-finite STK amounts before OAuth rather than rounding ledger amounts; compare callback amounts exactly; require an explicit non-negative integer result code in both callback verification and status reconciliation. Empty/malformed results cannot become success through numeric coercion. Production configuration is labelled "Production configured", with an explanation that authentication tests do not prove payment completion.

Guest folio creation also gives each genuinely new installment its own pending payment after the previous attempt completes; equal-sized installments no longer risk reusing a previously confirmed payment row. Provider requests have 20-second timeouts, and STK HTTP 5xx responses retain an uncertain outcome rather than permitting an automatic fresh attempt.

Final focused regression: **148 passed across 10 files**, including 13 isolated database dispatch tests, 7 handler dispatch tests, 24 provider-boundary tests, 10 callback tests and 9 connection/status-query tests. Focused ESLint passed. An intermediate parallel run exceeded the database fixture's 10-second startup hook while production bundling was busy; the fixture allowance was increased to 30 seconds and the complete serial run passed without skipped cases. Test batches in earlier sections overlap and must not be added together.

Deployment requirements are concrete: install the unapplied 12 November payment migrations (`20261112130000`, `20261112140000`, `20261112150000`) in order through the project's Lovable database process, deploy the matching source, and verify the existing Lovable server-secret binding and tenant Daraja configuration. Do not replace the privileged key with a public key or create a different database. The original environment/isolation, callback verification and token-hashing fixes must accompany this change. No migration or deployment was performed in this session.

`supabase/repair/2026-11-12/MPESA_DISPATCH_READ_ONLY_POSTCHECK.sql` provides an installation/permission check without reading keys or payment records. All returned installation/permission flags should be true after installation. This does not test real provider delivery.

The final client/server production build passed, with existing deprecation/bundling warnings; its synthetic server-key sentinel was absent from all **889 public files**. Separate RPC manifest/access checks passed **13 tests** after removing three obsolete direct-call entries now replaced by the atomic routines. No public/anonymous dispatch access was added. Build logs are local ignored output in `logs/mpesa-final-build.log`.

The final TypeScript check passed (`tsc --noEmit --incremental`), with its cache kept under ignored `node_modules/.cache`. The final database-only rerun passed all 13 cases after adding closed-folio and canonical-phone validation. These checks establish local implementation evidence; the changes remain uncommitted and undeployed, and the rejected local server key remains unchanged.

The isolated database tests execute the new migration and its lock/reuse/claim/permission/rollback behavior against PGlite with stubbed existing payment-engine dependencies; they are not a test of the complete deployed database schema or a multi-session production load test. Handler/provider/callback tests use synthetic credentials and mocks. Live handset delivery, provider settlement, callback reachability and actual Lovable deployment remain unverified.

## Final codebase-only M-Pesa recovery pass, 13 November

The current local candidate adds a zero-row server-gateway preflight before guest folio, deposit and delivery start routines, preventing a rejected/unreachable server key from reserving a new guest balance. It does not fetch another tenant configuration before guest ownership is checked by the existing start routine. The check proves gateway access, not successful provider configuration or complete financial acceptance.

The legacy neo_mpesa_retry_callback routine re-applied stored ResultCode without a fresh provider query. The existing 20261112150000 candidate now replaces that routine with an unconditional refusal and revokes browser execution. Its UI call and obsolete manifest entry are removed. Recovery uses the existing authenticated Safaricom reconciliation path; old callback audit rows are retained rather than falsely marked resolved. This SQL change is unapplied and must be installed/reviewed with matching server handlers before release.

An STK callback arriving before the checkout response is saved is no longer silently acknowledged as finished: it is retained for provider-verified review and receives HTTP 503. This requests, but does not guarantee, provider retry. Lookup failures also return unavailable. Tenant/amount/provider checks still precede application.

Validation: 131 local payment tests, overlapping final 25 callback/SQL checks, 13 RPC guard/manifest checks, focused lint and full TypeScript passed. Final frozen-source build passed; source fingerprint matches, obsolete replay is absent, latest recovery is present and synthetic server key is absent from 889 public files.

Live M-Pesa remains unproved. The user-supplied original-backend report says atomic start/dispatch routines are missing, the local/Worker key is rejected, and the optional relay is off. No original handler update, migration installation, deployment, live prompt or old pending-attempt alteration was performed. No Lovable prompt was sent. The departmental matrix was then verified separately in the existing launch-readiness report.
