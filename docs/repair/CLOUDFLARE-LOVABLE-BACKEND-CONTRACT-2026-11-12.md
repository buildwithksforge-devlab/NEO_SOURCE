# NEØ Cloudflare-to-Lovable backend investigation and implementation contract

Date: 12 November 2026. **Design only; not implemented or verified from the independent deployment.**

**13 November local follow-up:** after this investigation the user authorized local code repairs/tests. The generic POS M-Pesa entry and fail-closed provider readiness are being repaired and tracked in [the execution queue](NEO-LAUNCH-EXECUTION-QUEUE-2026-11-13.md). This does not implement the proposed Cloudflare-to-Lovable bridge, change credentials, install migrations or establish live collections.

**13 November clarification:** the bridge below is a fallback design, not a mandatory replacement for the existing direct server implementation. The user reports that Cloudflare runs the local source against the same original database and SQL Editor changes. If a valid privileged key for that project can be provisioned in the Worker runtime, existing server handlers can use it directly. Read-only verification reproduced HTTP 200 for the local public key and HTTP 401 / Invalid API key for the local server key; the deployed Worker credential has not been verified. Shared database updates do not themselves synchronize runtime secrets or install local migrations.

## 13 November: optional relay implemented locally in the existing server entry

`src/server.ts` now has an opt-in, fixed-destination relay for existing production M-Pesa server functions. No new route/file or shared password was introduced. It carries the caller's existing session JWT; the original function's JWT validation, tenant resolution, permissions and database authorization remain authoritative. The bridge itself checks token shape, not the cryptographic validity or staff permissions. Original-backend authorization acceptance tests remain required.

Read-only public asset inspection found `mpesa.functions-Bth-088D.js` on Horizon, exporting settings, save, connection test, staff collection, reconciliation and delivery collection. Their six public IDs match the corresponding local production IDs. This is transport discovery, not proof of matching implementation bodies: IDs hash a source filename/function name, not the source contents. Guest folio/deposit exports were absent from that inspected original chunk. A settings request without a session returned HTTP 500 without business fields; it did **not** establish successful authentication or a reliable authorization-denial contract.

Configuration contract (server runtime values; neither flag is enabled by this work):

| Setting | Default | Effect |
|---|---|---|
| `NEO_LOVABLE_BRIDGE_ENABLED=true` | off | Relay the allowlisted existing settings/connection calls to `https://horizon-prime-os.lovable.app`; other app operations stay on their existing path. |
| `NEO_LOVABLE_BRIDGE_PAYMENTS_ENABLED=true` | off | Separately permit staff POS/folio STK, delivery STK and reconciliation through the original functions. Enable only after original implementation/installed SQL/callback safety parity and sandbox acceptance. |

There is no arbitrary destination, database proxy, privileged key in the browser, cookie forwarding or automatic retry/local fallback. Foreign origins, non-POST, query overrides, non-JSON uploads and bodies over 32 KiB are rejected. Responses retain the framework serialization/streaming headers and disable caching. Redirects/HTML shells are rejected. Plain un-serialized non-2xx responses are surfaced as errors so a framework JSON parser cannot turn them into false successes. Timeout/lost responses retain uncertainty; the relay does not create a second collection.

This initial implementation covers production `/_serverFn/<hash>` requests. Vite development-mode encoded IDs, guest folio/deposit, provider card/QR, PIN and print-agent transport are not covered by this relay. Existing PIN and print contracts still require separate parity checks; this is not a claim that those integrations work.

Remaining release steps for this option:

1. Review/synchronize the original privileged M-Pesa handlers with the local dispatch/callback fixes and verify the matching SQL routines already installed through SQL Editor; do not replay migrations blindly.
2. Deploy the reviewed relay source to the independent Worker and enable only the first flag. Perform an authenticated settings/connection check with a real staff session and denied/expired/other-tenant tests. This has not been performed.
3. Verify that the configured provider callback reaches a host with valid privileged access (normally the original Horizon host for this option). The relay does not rewrite saved callback configuration or proxy callbacks.
4. After the original atomic dispatch, amount/receipt checks, uncertainty handling and single-application invariants are proven, enable the second flag for controlled sandbox STK and callback/reconciliation acceptance. Connection success alone is insufficient.
5. Roll back transport by disabling the flags; inspect existing attempts first and never resend to compensate for an uncertain response. Disabling the relay restores the direct path, which still needs a valid local/Worker server key for privileged actions. It does not cancel, reverse or repair financial records.

Local validation: 57 focused tests passed (22 response/relay tests, 18 POS UI, 8 dispatch handlers, 9 connection boundaries); focused lint and full TypeScript passed. Final relay production build is tracked in the existing execution queue. No authenticated remote operation, deployment, environment/credential change, migration execution or live payment was performed.

## Subsequent Horizon report: current source and installed contract limits

The user supplied a read-only Horizon investigation reporting branch `neo-printing`, commit `88a9478399d898d0eb3468402be63fc45a0d53b1`. This commit is absent locally and this branch is absent from the current `buildwithksforge-devlab/NEO_SOURCE` remote. The user states no Horizon repository is available; proceed from available local source and the report without claiming identical deployed source.

The report confirms `neo_mpesa_collection_start` and `neo_mpesa_claim_dispatch` are **not installed**; the original code uses `neo_mpesa_txn_start` and no dispatch routine. `neo_mpesa_apply_result`, `neo_staff_login_device_resolve`, `neo_print_agent_claim` and `neo_print_agent_finish` are reported installed and service-role restricted. Review the existing forward-only candidate `20261112150000_mpesa_collection_dispatch_guard.sql` against actual installed dependencies before an authorized installation; neither installation nor original-handler synchronization has been performed here. This missing contract is a concrete reason to keep payment forwarding disabled.

The reported PIN endpoint is an in-app server broker, not an Edge Function: POST `/api/public/staff-pin-login`, `X-Neo-Device-Token: neowd_<64 hex>`, JSON `{pin}`. It hashes the scoped device proof, invokes the resolver and generates a one-time sign-in token; the browser performs `verifyOtp`. This matches the local proxy's upstream header. The local Deno source describes a different candidate implementation and its source tests do not establish a deployed Edge Function. The local proxy was hardened with `redirect: error` to avoid forwarding a device proof/PIN to a redirect destination.

Printing is reported to accept 32-200 character bearer credentials, with newer printer-computer and older connector authentication. Local API code accepts `neopc_<64 hex>` and the local agent is Node-based; reported Horizon includes a Python connector and browser print-station UI. Passing local queue/database tests does not prove that cross-version token/job/claim contracts match. An original privileged print endpoint can serve an independently hosted frontend sharing the database, but that endpoint/agent pairing still needs acceptance. No print proxy was added to the M-Pesa relay.

The report names a sandbox callback on Horizon and a production callback on `https://mawimbijikohotel.com/api/public/mpesa/callback/<redacted>`. Production callback hosting and privileged access are unverified. Do not use the enabled production tenant for tests; verify sandbox first. Public callback receipt alone is insufficient: matching checkout/tenant/amount, verified provider result and one financial application are required.

Latest local STK/PIN checks: 103 focused tests plus 15 Node agent tests passed. STK description now respects the supplied 13-character maximum, and accepted responses without a usable CheckoutRequestID remain ambiguous rather than being reported safely tracked. Windows read-only inventory found only PDF/OneNote queues. No real PIN login, physical print, live payment, migration or deployment occurred.

Additional local privileged callers outside this initial relay include integrated card/QR gateway and callback, delivery-provider gateway/callback, eTIMS, user administration, automation/internal push, public-app administration and AI-provider server access. These still need a valid privileged runtime or separately scoped authenticated backend adapter; the M-Pesa relay does not make them work automatically. Ordinary user-scoped/RLS database operations have a different access path, and must still pass their workflow acceptance tests.

## Scope and evidence boundary

Inspected the shared VS Code checkout at `C:/Users/Kelvin/Downloads/NEO_COMPLETE_2026-09-26/NEO_SOURCE`, its local build output, migrations, and existing evidence. The original database project is `zlrrmrcqlerafptkgucl`; the independent Worker is `neo-preview` at `https://neo-preview.neo-hospitality.workers.dev`. The current PIN proxy names `https://horizon-prime-os.lovable.app` as its upstream. That hostname must be confirmed as the original deployment before implementation.

The user's established constraint is that the privileged Lovable-managed database key remains inside the original backend. This design accepts that constraint; it neither exports the key nor proposes a replacement database.

The deployed original Lovable source/configuration was **not** inspected through an authenticated Lovable interface. Existing route declarations below establish local implementation, not deployed availability. The generated function IDs belong to the existing local build, not a verified remote release. No endpoints were invoked, tests run, credentials read/modified, database records changed, migrations installed, application behavior modified, commits made, or deployments performed during this investigation. Only this documentation is new.

## What the reported payment screen means

The reported numbers are consistent with the payment engine's pending-balance reservation:

`KES 1,802.50 outstanding − KES 1,802.50 pending = KES 0.00 available for another attempt`.

This prevents another collection from taking the same balance. It does **not** prove the customer received a phone prompt or that funds moved. `STK-4229F168-B72` has the form of an app-generated request reference; it is not independently verified evidence of an M-Pesa receipt. The exact affected database row was not inspected, so its provider outcome is unknown.

The manual confirmation button calls `pos_confirm_manual_payment(paymentId, note)`. That routine requires manual-confirm permission, tenant/property access, a pending/initiated payment, a non-empty reference and note, and a remaining balance. It then marks the entry confirmed and audits the staff member. It does **not** initiate STK, query Safaricom, debit a card, or independently prove receipt of money. An internal STK reference can satisfy its current non-empty-reference check.

**Do not use manual confirmation to clear this error without independent evidence of actual receipt.** Investigation/reconciliation must distinguish: definitely never sent; sent and pending; successful; definitively declined; or uncertain. An uncertain attempt must not be discarded or recollected automatically. No recovery action against this payment was performed.

### Missed collection entry point

In `src/routes/_shell.pos.orders.$id.tsx`, `PaymentDialog` offers `mpesa` in `methodsFor(...)`, but its submit handler calls `record.mutate(...)`. Only `card-terminal`/`qr` enter the subsequent provider-intent dispatch branch. Selecting M-Pesa there can therefore create a pending payment **without calling `chargeWithMpesa` or STK**.

The separate `MpesaPromptDialog` calls `chargeWithMpesa`, which does dispatch STK after the database/claim boundary. The two entry points are not equivalent. Earlier claims that the M-Pesa code repair was complete were too broad: the generic POS entry point remains an integration blocker. It is identified here, not changed.

The generic integrated card/QR flow also creates its linked pending payment before opening/dispatching the provider intent. Provider setup or dispatch refusal can leave that first payment pending. `PaymentMethodPicker` does not disable provider choices when readiness has not loaded or returned a row, and the generic submit-disabled calculation does not independently enforce readiness.

### What can work locally

| Mode | Does NEØ move electronic funds? | What completion means |
|---|---|---|
| Cash | No electronic debit | Staff actually receives cash; the authorized till records it. |
| Ordinary card-slip recording (`card`) | No | A separate bank terminal already processed the card; NEØ records its reference/metadata for reconciliation. |
| Bank-transfer recording | No | The transfer happened outside NEØ and requires matching/verification. |
| Integrated card terminal (`card-terminal`) | Through a configured bank/acquirer/terminal integration | Processor authorization/capture response matched to the intent; bank settlement may occur later. |
| M-Pesa STK | Through Safaricom | Customer authorization followed by verified provider result, matching receipt and one ledger application. |
| Local simulator | No | Synthetic test outcome only; it must never certify receipt of real money. |

A locally running POS can operate its interface, record cash, and talk to a supported local terminal/agent. It cannot debit arbitrary bank cards or M-Pesa accounts without an authorized payment network. The integration should hide that complexity from staff, not manufacture a paid result. An authorization is also distinct from funds settling into the merchant's bank account; merchant account configuration and settlement reconciliation are separate evidence.

## Phase 1 — Existing endpoints

### M-Pesa framework server functions

These are TanStack Start server functions, **not stable `/api/mpesa/...` REST endpoints**. Source: `src/lib/mpesa.functions.ts`. They all use POST and `requireSupabaseAuth` from `src/integrations/supabase/auth-middleware.ts`.

The middleware requires `Authorization: Bearer <original-project user access JWT>`, verifies claims through the configured project's Auth client, and builds a user-scoped database client with the public API key. It does not require the service-role key merely to validate the user. Privileged credential loading, dispatch claims, application of payment results and other trusted operations do require the backend's own privileged client.

The local build uses `/_serverFn/<id>`. Its transport adds `x-tsr-serverFn: true`, framework serialization and negotiated response types; it is not a supported plain-JSON inter-service contract. See `node_modules/@tanstack/start-client-core/src/client-rpc/serverFnFetcher.ts`. A matching generated client can call a matching build; do not hard-code these IDs as the durable integration API.

| Function | Exact local-build POST path | Logical request data | Logical result and authorization |
|---|---|---|---|
| `getMpesaSettings` | `/_serverFn/a298d96ac388c4c939b606b376547f88b23dbf95f9c193d59a8926c1baf2f8c0` | No data | Admin-authorized settings, presence flags, environment, callback configuration/readiness. Getter excludes stored Daraja keys but returns the callback bearer token to an authorized admin. |
| `saveMpesaSettings` | `/_serverFn/bd198ea576866cf0896fbe69ba30d389a10236d7c2330976469561e554d92e03` | `environment`; optional shortcode, party B, reference, transaction type, credential drafts, callback base, enabled/clear/rotate flags | `authorised`, `saved`, completeness/enabled flags, missing fields/reason; tenant admin RPC. Rotation is an explicit configuration write, not part of this investigation. |
| `testMpesaConnection` | `/_serverFn/ad043ee140ba978f053a297c76e78345643b42f3bfd28eee8ad60f618cde9855` | Optional `environment`, `consumerKey`, `consumerSecret` | `authorised`, `ok`, `status`, `detail`, environment, duration. Admin settings RPC gates access. Complete drafts skip saved-secret loading; saved tests load privileged credentials and may record check metadata. OAuth only, not a payment test. |
| `chargeWithMpesa` | `/_serverFn/9da0afc433195f41243eb2d86b167de79fb5b2707cfbb1bda8088afd3d76f3fd` | `sourceModule: pos_order|folio`, `sourceRecordId`, `msisdn`, `amount`; optional description | `ok`, status/detail, transaction ID; optional checkout ID/customer message/reused/amount. Actor organization resolved from profile; atomic collection RPC enforces permission/property/balance. One-time privileged claim before STK. |
| `reconcileMpesaTransaction` | `/_serverFn/e9409f285f66cf784b5c66c6197de83b3e7845953b5d207a0bea88432d90af1a` | `transactionId` | `ok`, status/detail, optional duplicate; user-visible row plus collection permission, then privileged credentials, provider query and apply. Already-applied check avoids replay; final database lock is authoritative. This can change financial records. |
| `chargeDeliveryWithMpesa` | `/_serverFn/8f1dadac4fa9729e857403dafc8ef4d24a22bce0247595af2eebe91e4b203fc1` | `orderId`, `msisdn` | `ok`, status/detail, optional transaction/amount. Guest ownership and payable amount established by delivery-start RPC; outstanding pending amounts block recollection; claim before STK. |
| `chargeGuestFolioWithMpesa` | `/_serverFn/1ef9d0260286ca208a4e39b86f242b97adf2a388b6d780f95a36143e976bc18c` | `organizationId`, `folioId`, `msisdn`; optional amount | Same collection result. Organization selector is not authority: collection RPC verifies guest customer ownership/property and active attempt before privileged dispatch. |
| `chargeGuestDepositWithMpesa` | `/_serverFn/1029e96261143a6cd861d02888c8ee3c2f5ec1654855449940497f839f6bf169` | `organizationId`, reservation `reference`, `msisdn`; optional amount | Same collection result. Guest/reservation ownership checked in RPC; active/uncertain prompt reused, then claim before STK. |

Existing source-level idempotency improvements depend on local migrations `20261112130000`, `20261112140000`, `20261112150000`. Their presence on disk does not establish installation in the original database. `20261112150000` supplies atomic collection creation/reuse and service-only dispatch claims. Existing active attempts are conservatively marked previously claimed; this is not permission to resend historical attempts.

### Public provider callback

**POST `/api/public/mpesa/callback/{token}`**, source `src/routes/api/public/mpesa.callback.$token.ts`.

- No user JWT: possession of the tenant callback token starts lookup, followed by trusted transaction/provider verification. This is custom authentication, not an unauthenticated privileged API.
- Request: Safaricom `Body.stkCallback`, including `CheckoutRequestID`, result code/description, optional merchant ID, and metadata items for successful amount/receipt/date/phone.
- Token resolves one organization; checkout lookup is constrained to that organization. The handler queries Daraja server-side, checks explicit result code, available merchant/checkout identifiers, and exact successful amount before applying.
- Response: JSON acknowledgement `{ResultCode:0,ResultDesc:"Accepted"}` for acknowledged/duplicate/unmatched cases; 401 invalid token; 400 invalid JSON; 503 verification unavailable; 500 apply failure. An ACK is not a general declaration that money was received.
- Database `neo_mpesa_apply_result` locks the transaction and guards `applied_at`; it must remain privileged-only. No callback token, query string or full secret-bearing path should enter logs.
- The current code requests retries using errors, but recovery must not depend on Safaricom retrying callbacks. Query/reconciliation is required for missing callbacks.

### Staff PIN

**POST `/api/public/staff-pin-login`**, source `src/routes/api/public/staff-pin-login.ts`:

- Browser header `Authorization: Bearer neowd_<64 lowercase hex>`; JSON `{pin: "<six digits>"}`. No caller organization/user override.
- Validates shape/size, then forwards to the hard-coded Lovable broker URL with `x-neo-device-token`, fixed Origin, JSON PIN and a 15-second timeout. Response `{token_hash, branch_id}` or structured error; no-store.
- **Contract gap:** this local route itself accepts only Authorization, whereas its upstream request sends `x-neo-device-token`. If the original host runs this same route unchanged, it will reject that upstream header. Original deployed broker behavior has not been inspected. Also avoid configuring either proxy to call itself.

Existing Edge Function source: `supabase/functions/neo-staff-pin-login/index.ts`; conventional project endpoint **POST `https://zlrrmrcqlerafptkgucl.supabase.co/functions/v1/neo-staff-pin-login`**, deployment not verified here.

- Accepts `x-neo-device-token`, a device-token body field, or a Bearer device token. Body contains six-digit PIN. `supabase/config.toml` has `verify_jwt=false` for this function because these device credentials are not user JWTs.
- Hashes device token, invokes privileged `neo_staff_login_device_resolve`, then generates a one-time Auth login proof for the resolved identity. Browser consumes `token_hash` with `supabase.auth.verifyOtp({type:"magiclink"})` against the original project.
- Database device resolver checks revocation/expiry, locks attempts, limits attempts and locks the device after five failures within the configured window, scopes PIN matches to the device organization, and verifies active staff/property access. Repeated login is a new authentication attempt, not a payment idempotency key.
- No-store responses; never log PIN/device token/login proof. A hard-coded Origin value is not authentication.

### Print agent

All are **POST `/api/public/print-agent/{action}`**, source `src/routes/api/public/print-agent.$action.ts`. Header is `Authorization: Bearer neopc_<64 lowercase hex>`. Backend hashes it; database routines resolve an active agent and its organization/property. Current route requires the privileged server client on the host that serves it.

| Action | Required JSON fields | Current success envelope / rules |
|---|---|---|
| `printers` | `{}` | `{printers: [...]}` restricted by agent scope. |
| `claim` | `printer_id: UUID` | `{job:null}` or `{job:{job_id,claim_id,document_type,title,payload,attempt,max_attempts,printer}}`; printer must belong to agent scope, queue claim uses `FOR UPDATE SKIP LOCKED`, two-minute lease in inspected SQL. |
| `finish` | `job_id`, `claim_id`, `outcome: completed|not_printed|outcome_unknown`; optional error ≤1,000 chars | `{status: <database result object>}` — currently nested, not a plain string. Database verifies agent/job/claim/state. Replayed stale finish conflicts rather than printing again. Unknown physical outcome must not auto-reprint. |
| `discovery` | `{}` | `{request:null|{request_id,kind}}`; active property agent, current discovery request. |
| `discovered` | `request_id`, `result` object containing printers array | Database result `{ok:true,...}`; request match/expiry, payload validation; duplicate acknowledgement does not replace the saved result. |

Current HTTP errors: 401 malformed/unknown agent token; 400 invalid IDs/outcome/JSON; 413 oversized payload; 409 invalid/stale/scope claim; 500 internal RPC failure; 502 malformed database response; 404 unknown action. Request limits are 4,096 bytes normally and 64,000 for discovered reports.

For discovery reports, the inspected database contract allows at most 100 printer objects. Each has `name` length 1–240, optional `address` at most 500 characters, and `connection_type: network|windows|unsupported`. Keep document `payload` as the existing print-agent protocol object; do not reinterpret its fields in the proxy. Claim/finish are operational writes, not read-only health checks, and were not invoked in this investigation.

### Can the independent Worker call these today?

Server-to-server HTTP does not require browser CORS permission. It still requires valid credentials, a deployed compatible endpoint and successful authorization. User JWTs from the original project can be forwarded without exporting the privileged database key. Device and print-agent tokens authenticate their own narrow protocols.

The current local M-Pesa and print handlers execute privileged operations **on whichever host serves them**. Running those handlers unchanged on the independent Worker therefore still requires its missing privileged key. They do not currently delegate to Lovable. The PIN route already attempts delegation but has the header/deployment mismatch described above.

Calling original Lovable-hosted framework functions is technically possible with its matching transport and user session, **if** that exact backend version is deployed and publicly callable. That has not been established from `neo-preview`. The current evidence is insufficient to declare cross-host integration operational. No CORS configuration can cure missing backend privileges.

## Phase 2 — Security boundaries and remaining gaps

| Boundary | Source evidence | Assessment / required work |
|---|---|---|
| Cross-organization impersonation | Auth middleware verifies JWT; staff organization resolved from profile/current-org RPCs; guest collection RPC checks customer ownership; callback token+checkout lookup scoped to org. | Source protections present. Actual deployed RLS/grants and stale/disabled-account behavior must be tested. Never trust body `user_id`/staff organization or Worker-supplied identity headers. |
| Read another tenant's Daraja settings | Settings RPC is admin/current-org scoped; stored credentials loaded only through trusted server module. | Keep admin gate before any privileged read. Bridge must not provide arbitrary organization settings or raw secrets. Authorized getter currently exposes callback bearer URL; prevent logs/cache leakage. |
| Unauthorized STK | Authenticated source ownership, module permission and property checks; service-only dispatch claim in local migration. | Preserve these checks on Lovable. A valid machine signature must not substitute for user authority to initiate a collection. Generic POS entry-point gap remains unresolved. |
| Duplicate collection/application | Source bill/reservation locks, active/uncertain reuse, one-time claim; apply locks and `applied_at`. | Local implementation only until installed. Do not issue a new transaction or key after a Worker timeout. Two independent browser sessions must be acceptance-tested. |
| Forged M-Pesa callback | Tenant token, server-side Daraja query, identifier/code/exact amount checks. | This is not a provider signature. Query does not independently attest every supplied receipt/phone metadata field. Protect tokens, validate metadata and reconcile receipts/statements; do not claim arbitrary forgery is impossible. |
| Status reconciliation replay | Visible transaction+permission; apply lock/guard. | Keep in original backend. Provider result identifiers should also be compared when present. A successful query may precede receipt-bearing callback; test later receipt enrichment without another financial application. |
| Manual confirmation | `pos_confirm_manual_payment` checks permission, scope, balance, note and a non-empty reference. | It can confirm without independent provider proof; STK request reference is not a receipt. It is a separate audited override, not the automatic collection path. Define policy and UI truthfully before production. |
| Generic card/QR setup and linking | `PaymentDialog` records first; intent opening may then fail. `neo_payment_intent_open` checks linked row exists in tenant. | Requires atomic readiness/intent/payment boundary; validate linked record's source, property, method, currency and amount, not only tenant and ID. Current readiness UI fails open while a readiness row is absent. |
| Card/QR dispatch connection | `payment-gateway.functions.ts` selects connection by provider and ordering without an explicit requested-branch predicate. | RLS may constrain tenant, but selection can use another property configuration. Reuse the exact validated connection/branch from intent creation. |
| Card/QR uncertain result and apply failure | Dispatch catches network failure and marks failed; immediate `neo_payment_intent_apply` result is ignored before returning approved state. | Unknown transport outcome must not be treated as safe to recollect; check application errors before reporting confirmation. |
| Card/QR callback assurance | Callback token hashes and lock/replay logic in `20261112140000`; callback body only supplies outcome/reference/detail. | Generic token-based callback lacks provider-specific signature and amount/currency/merchant verification. Real acquirer adapters must implement their verification contract before real collection. |
| Sandbox isolation | `payments.simulator.terminal.ts` refuses request environment other than sandbox; generic apply routine shown has no environment barrier before linking confirmation to a payment. | Do not connect simulator to real operational balances. Test and enforce isolation at the backend application boundary, not a UI badge. Simulator approval is not real-money proof. |
| PIN scope/authentication | Device token hash, expiry/revocation/rate limits, active staff/branch checks, one-time login proof. | Preserve inside original backend. Resolve proxy-header mismatch; test locked/revoked device and disabled staff. IP-only rate limiting or Origin checks are insufficient. |
| Print spoof/replay | Hashed active agent token, property/printer scope, locked job claim, claim ID and state checks. | Preserve original database routines; check final installed lease rules, duplicate finishes and unknown-outcome handling. Do not accept browser user JWT as an agent token. |
| Endpoint SSRF and response leakage | Generic gateway uses HTTPS configured endpoint; callback base can fall back to request Origin/Host. | HTTPS alone does not authorize arbitrary destinations. Use vetted provider endpoints, explicit callback origin, redirect controls and sanitized diagnostics. No arbitrary URL/RPC/table forwarding bridge. |

Exact relevant files: `src/routes/_shell.pos.orders.$id.tsx` (payment options/submission around 960/1,190, confirmation around 802); `src/lib/pos-data.ts` (`useRecordPayment`, `useConfirmManualPayment`); `src/lib/payment-gateway.functions.ts` (connection selection around 118, dispatch around 229, immediate application around 275); `src/components/payments/PaymentMethodPicker.tsx` (missing-readiness behavior); `supabase/migrations/20260822165814_f5d999aa-54b8-4639-bd27-0f11d6540200.sql` (`pos_confirm_manual_payment`); `20261112140000_provider_payment_dispatch_safety.sql` (intent linking/application); `20261112150000_mpesa_collection_dispatch_guard.sql`; `src/lib/mpesa.functions.ts`; `src/routes/api/public/mpesa.callback.$token.ts`; PIN and print files listed above.

## Phase 3 — Proposed integration architecture

**Recommendation: original Lovable backend owns provider calls and financial application; Cloudflare owns its frontend and narrow authenticated forwarding routes.** Keep normal user-scoped reads/RPCs on the existing original-project public client where appropriate. Do not relay every database operation through a new privileged gateway.

### User-authorized operations

Propose a versioned Edge Function **`neo-payments-api`** in the original project. It exposes only named operations below. Inside it:

1. Validate the original-project user JWT using the project Auth verification SDK; check issuer/project, audience, expiry, active profile and current permissions/property or guest ownership.
2. Create a user-scoped database client with that JWT for authorization/RLS-bound work.
3. Only after authorization, use the backend's existing privileged client for credential loading, claim/apply and provider verification. Never replace the scoped client with the admin client for permission checks.
4. Reuse existing transaction IDs, provider request IDs, bill/reservation locks and apply routines. No generic service-role RPC proxy.

Cloudflare forwards `Authorization: Bearer <access JWT>`, project public `apikey`, JSON and request/idempotency correlation to an allowlisted backend origin/path. Never forward refresh tokens. Browser session refresh remains with the original Auth SDK. Do not impersonate the user with supplied claims or use the public API key as an identity token.

The documented distinction between the user JWT Authorization header and public API key header is described in [Supabase authorization headers](https://supabase.com/docs/guides/functions/auth-headers). Handler-level authorization remains required; platform JWT settings are not a substitute for tenant/permission checks.

Current Daraja code mixes Node/TanStack context and `process.env` with provider logic. A Deno Edge Function cannot simply import that module unchanged. Extract a runtime-neutral Daraja client with injected credentials, fetch and clock; keep framework and environment adapters separate. Validate behavior equivalence with existing fixtures before changing the call path.

### Callbacks, device PIN and print agents

- Keep a custom-authenticated **`neo-mpesa-callback`** function separate from user-JWT operations. Do not require a staff session from Safaricom. Token lookup and provider verification are mandatory.
- Keep existing externally issued callback URLs working. The original `/api/public/mpesa/callback/{token}` route can internally adapt to the trusted backend; a previously issued Cloudflare callback URL can transparently relay raw body+token to a fixed original endpoint. Never rotate tokens or replay/recreate payments as part of deploying the bridge.
- Reuse `neo-staff-pin-login` after verifying its deployed URL and input contract. Update only the Worker adapter in the implementation phase; do not introduce an organization-wide master PIN.
- Propose **`neo-print-agent`**, using the existing hashed agent token protocol and RPCs, with a Cloudflare route adapter that preserves existing agent URLs. No user impersonation and no direct database credentials on the property machine.
- JWT-free functions still have mandatory custom authentication. If `verify_jwt=false` is needed for provider/device/agent credentials, configure it narrowly per function and fail closed in the handler. Keep the user payments function JWT-gated and validate its user token in code as well. [Supabase function authentication](https://supabase.com/docs/guides/functions/auth)

### Optional machine authentication

Interactive user operations need a user JWT, not a new broad machine credential. Prefer scheduled reconciliation in the original backend, so the Worker needs no privileged background identity.

If independent Worker-to-backend machine calls are later required, provision a **separate purpose-limited signing key** through authorized Cloudflare/Lovable secret interfaces. It is not the Supabase service-role key and grants no arbitrary database access. Prefer an Ed25519 private key stored only as a Worker secret and its public verification key registered on the backend. A shared HMAC key stored in both secret stores is an alternative if operational tooling supports it better. Neither key is created/provisioned in this design.

Proposed signed envelope: version, key ID, HTTP method, canonical target path/query, SHA-256 of the exact body, SHA-256 of the user JWT when present, idempotency key, timestamp and random nonce. Define one exact UTF-8/base64url encoding in the implementation. Reject unknown key/algorithm, body/path/token mismatch, timestamps beyond 30 seconds, and repeated nonces. Atomically reserve nonces for five minutes in backend durable storage; nonce protection is separate from durable payment idempotency. Retries use a new nonce but the same business key and transaction ID.

Machine authorization is an explicit key-ID allowlist of operations/orgs/properties. A reconciliation-only key can query/apply the verified result of an **existing** transaction; it cannot initiate payments, manually confirm, load settings, pick a new organization or execute arbitrary RPCs. Interactive STK still needs the authorized user's JWT. CORS/Origin is never used as machine authentication. Rotate/revoke this independent key without rotating callback tokens or database keys.

## Phase 4 — Proposed implementation contract

Every path in this section is **proposed**, not an existing deployed endpoint. JSON request schemas are closed (`additionalProperties:false`), with validated UUIDs/enums, finite amounts and bounded strings. User request body limit: 16 KiB. Callback and print-report limits: 64 KiB. PIN keeps its existing small request limit.

### Stable operation routes

Backend base: `https://zlrrmrcqlerafptkgucl.supabase.co/functions/v1/neo-payments-api`.

Suggested Worker facade: `/api/backend/v1`. Both use POST for the operations below. A non-mutating status read is distinct from provider reconciliation, which can apply a financial result.

| Worker suffix | Backend suffix | JSON request | Response data / authority |
|---|---|---|---|
| `/mpesa/settings/get` | `/v1/mpesa/settings/get` | `{}` | Sanitized `MpesaSettings`; admin. Mask callback URL by default; expose full bearer URL only through a separately authorized no-store admin operation when genuinely needed. |
| `/mpesa/connection/test` | `/v1/mpesa/connection/test` | `{environment?:sandbox|production, consumerKey?:string, consumerSecret?:string}` | Connection test fields from existing function. Drafts are transient and never logged/returned/persisted by testing. No STK request. |
| `/mpesa/collections/start` | `/v1/mpesa/collections/start` | `{sourceModule:pos_order|folio, sourceRecordId:UUID, msisdn:string, amount:positiveWholeKES, description?:string}` | Collection result with existing transaction ID, status, reused flag and provider checkout reference if saved. Staff scope/permission and balance enforced on backend. |
| `/mpesa/delivery/start` | `/v1/mpesa/delivery/start` | `{orderId:UUID, msisdn:string}` | Same collection result; amount derived from owned delivery bill. |
| `/mpesa/guest-folio/start` | `/v1/mpesa/guest-folio/start` | `{organizationId:UUID, folioId:UUID, msisdn:string, amount?:positiveWholeKES}` | Guest ownership checked for the original organization selector; no arbitrary staff identity. |
| `/mpesa/guest-deposit/start` | `/v1/mpesa/guest-deposit/start` | `{organizationId:UUID, reference:string, msisdn:string, amount?:positiveWholeKES}` | Owned reservation/deposit position; existing pending/unknown attempt returned. Define how fractional deposit requirements are settled without silently rounding financial amounts. |
| `/mpesa/transactions/status` | `/v1/mpesa/transactions/status` | `{transactionId:UUID}` | `{transactionId,status,amount,currency,receipt,detail,appliedAt}` from caller-visible row only; no provider call or application. Add dedicated guest-own read authorization; do not reuse staff-admin reconciliation permission for guests. |
| `/mpesa/transactions/reconcile` | `/v1/mpesa/transactions/reconcile` | `{transactionId:UUID}` | `{transactionId,status,detail,applied,duplicate}` after authoritative provider query/application; staff collection/reconciliation permission or explicitly scoped machine schedule. |

Do not add a general settings-save, manual-confirm, cancel or refund operation to the first bridge release. Existing authorized configuration routines remain separate. These are money/configuration behavior changes requiring a separately reviewed contract and evidence.

Response envelope (proposal): `{version:1, requestId:string, ok:boolean, data?:object, error?:{code:string,message:string,retryable:boolean,transactionId?:UUID}}`. `status` retains existing transaction semantics; the UI must not interpret HTTP 200, `ok:true`, `pending` or `reused` as funds received. The same transaction ID must survive timeout/error responses where known. Never return OAuth tokens, stored Daraja credentials, privileged keys, PINs or raw provider diagnostics.

HTTP contract: 200 read/completed operation; 202 accepted/pending/unknown collection with existing transaction ID; 400 invalid request; 401 missing/invalid/expired credential; 403 valid identity lacking scope; 404 inaccessible/unknown resource without cross-tenant disclosure; 409 idempotency-payload mismatch or incompatible state; 422 invalid currency/fractional amount/business balance; 429 rate limit; 503 missing backend/provider configuration. After possible provider acceptance, a timeout/server failure is **unknown**, not evidence of no charge.

Initiation/reconciliation requests carry `Idempotency-Key` and `X-Request-ID`. Persist a backend request record scoped to verified actor+organization+operation+business key, with canonical payload hash, existing transaction ID and stable outcome. Same key/different payload returns 409. Same key/same payload returns the saved attempt. Active-attempt reuse additionally protects changed keys for the same bill. This durable request-record addition is a **future implementation requirement**, not a claim that the current schema already supports this HTTP contract. It must not replace existing financial IDs/keys or permit concurrent duplicate sends.

Read-only status/settings/test requests need no financial idempotency key. Rate-limit OAuth tests independently. The total proxy deadline must account for OAuth, STK and database time; an aborted fetch never authorizes a new attempt. Disable automatic POST retries unless the durable business key is preserved and the backend can prove safe reuse.

Proposed provider callback: POST `https://zlrrmrcqlerafptkgucl.supabase.co/functions/v1/neo-mpesa-callback/{token}` with raw Safaricom JSON, no user JWT. Existing app callback URLs stay as compatibility adapters; generate new URLs only after explicit rollout approval and outstanding-attempt review. Host must be fixed public HTTPS, not browser Origin/Host or preview-host inference. Token stays out of logs/referrers/analytics. GET must never apply a result.

Proposed print backend: POST `https://zlrrmrcqlerafptkgucl.supabase.co/functions/v1/neo-print-agent/{action}`, same token, bodies, envelopes and claim semantics as existing route. Worker preserves `/api/public/print-agent/{action}` and forwards only allowlisted actions. Proposed PIN adapter targets the existing verified original PIN broker/Edge Function contract and preserves browser route and `verifyOtp` flow.

### Required Cloudflare changes — implementation phase only

1. Add a server-only fixed-origin bridge client, e.g. `src/lib/lovable-backend.server.ts`, with timeout, size limits, redirect refusal, sanitized errors, correlation and no arbitrary destinations.
2. Configure only original backend URL/public key and optional dedicated machine-signing material. Remove dependence on exported `SUPABASE_SERVICE_ROLE_KEY` for the bridged operations; retain fail-closed behavior for any unconverted privileged routes.
3. Make current M-Pesa server functions thin authenticated adapters to the versioned backend, preserving browser call sites and transaction/result contracts. Do not duplicate provider dispatch in both hosts.
4. Route **every** POS M-Pesa entry point to the same collection operation. Fix the generic Take payment path instead of only the separate prompt dialog. Readiness must fail closed before creating a new provider-backed payment. This payment/UI change is proposed, not performed here.
5. Preserve existing PIN and print-agent facade routes while updating their upstream contracts. Do not forward arbitrary browser headers, cookies or refresh tokens. Never log PIN, provider credential drafts, agent tokens, JWTs or tokenized callback paths.
6. Add status/recovery UI that reopens the existing attempt, distinguishes pending/unknown from paid, shows actual provider/receipt evidence and never offers manual confirmation as a substitute for collecting funds. A safe pending-attempt cancellation policy is a separate design, not permission to delete this KES 1,802.50 entry.
7. Card/QR provider adapters and atomic creation fixes need their own acceptance gate; do not market generic placeholder/simulator wiring as supermarket-grade acquiring.

### Required original Lovable backend changes — implementation phase only

1. Confirm original project/domain/branch and inspect its **deployed** code, RPC signatures, grants/RLS and secret presence using authorized interfaces without exporting values. Confirm which prior migrations are installed before selecting forward migrations.
2. Add `neo-payments-api`, `neo-mpesa-callback` and `neo-print-agent` function adapters; reuse verified `neo-staff-pin-login`. Extract/runtime-adapt shared provider/domain code. Keep privileged credentials and database client inside the original backend only.
3. Retain actor-scoped authorization, property/guest ownership, active-attempt reuse, one-time dispatch, callback verification and locked one-time application. Do not create an arbitrary admin RPC endpoint or trust the Worker to declare actor/org/amount authority.
4. Design and review durable request-idempotency records and any optional nonce/key allowlist storage as explicit future schema work. Preserve all existing IDs, receipts and idempotency keys. No historical data cleanup or key rotation bundled with deployment.
5. Separate sandbox/provider test activity from live balances, restrict any audited manual override according to approved policy, and retain query-based recovery when callbacks are lost.

### Security tests required before release

- Reject missing/expired/forged/wrong-project JWTs and publishable-key-only requests; reject disabled users and revoked permissions, even with a previously valid token. Test original project signing-key behavior with the deployed SDK.
- Org A cannot read settings, start/reconcile/read an Org B payment, or access its guest reservation/folio; same-tenant disallowed property is denied. Changing body org/branch/user claims cannot widen access.
- A revoked/expired/wrong-property device token, wrong PIN, locked PIN/device and non-active staff cannot mint a session. Verify rate limiting and no PIN/token leakage. Confirm Cloudflare-to-original PIN header contract and no proxy loop.
- Wrong/disabled agent token, foreign printer, expired/stale claim, duplicate finish and duplicate discovery cannot print another job or overwrite reports. Unknown physical output does not auto-reprint.
- Two browsers and two Worker requests racing on one bill yield one active collection and at most one provider dispatch. Same key/different payload conflicts; timeout retry preserves transaction and does not send again.
- Database/provider failure at each initiation boundary does not orphan a misleading collectible pending entry. Provider network loss/5xx/malformed successful response remain uncertain. Final application failure is visible, not reported approved.
- Wrong callback token, foreign checkout, amount mismatch, malformed result, merchant mismatch, unavailable query and leaked-token/forged metadata attempts do not post unverified money. Repeated callback/status-query races apply once. A later receipt-bearing callback can be reconciled without a second posting.
- Simulator and sandbox tokens/configuration cannot settle live operational bills. Card callback checks provider-specific signature/merchant/amount/currency. A synthetic success cannot satisfy real-money acceptance.
- Bridge rejects arbitrary upstream URLs, redirects, unallowlisted routes/RPCs, oversized payloads and injected identity headers. Optional signatures fail on tampering, replay, wrong audience/key/scope and stale timestamps. Original callback custom auth cannot be bypassed by CORS headers.
- Public bundle/log/error/cache scan contains no privileged/provider/machine/agent/session secrets or tokenized callback URLs.

### M-Pesa sandbox acceptance from the independent Worker

Run later only inside an authorized sandbox/test-data boundary, not during this investigation:

1. Record matching app/backend commit IDs, migration signatures, original project ID, explicit sandbox environment, isolated merchant/test bill and allowed test handset. Confirm no production merchant or real customer is targeted.
2. From `neo-preview`, test OAuth using the original user's session. Confirm failure before any payment when provider setup is incomplete; a successful OAuth test is not collection proof.
3. From the **generic POS Take payment M-Pesa option** and the dedicated prompt dialog, request one whole-KES amount through the same backend operation. Observe one transaction, one pending payment, one provider checkout ID and one actual sandbox prompt.
4. Complete the sandbox authorization; verify callback/query against the same transaction, amount, currency, property and merchant; check one receipt/application, changed bill balance, required Finance posting and no duplicate journal. No manual-confirm click is permitted as a substitute.
5. Repeat for staff folio, guest-owned folio, guest deposit and delivery, including equal successive installments and changed-input repeat clicks. Denied guest/property cases must leave no money/stock/history mutation.
6. Test customer cancellation, timeout, delayed/missing callback, lost request/response, provider 5xx, frontend reload, concurrent clicks, callback replay and query/callback race. Confirm existing-attempt recovery and no automatic fresh charge on uncertainty.
7. Test card acquiring separately with the bank's terminal/acquirer sandbox. Verify authorization/capture/settlement distinctions and which merchant account receives settlement. It is not covered by an M-Pesa sandbox pass.
8. Capture redacted proof from the **deployed independent Worker and original backend**, with transaction/receipt/journal IDs and scope-denial results. Local mocks or curl from this workstation alone do not establish cross-deployment acceptance.

### Rollback

Record original backend/Worker version IDs and outstanding attempts before rollout. Release behind an operation-specific backend-selection flag. On regression, disable **new collection initiation** rather than falling back to a second provider-dispatch implementation. Keep callbacks and reconciliation on the original backend functioning for every outstanding transaction and existing token URL. Roll back code through normal forward/revert commits and deployment versions; never force-push/rebase pushed Lovable history. Additive idempotency/claim records remain in place; no destructive schema rollback, pending-row deletion, transaction-ID regeneration, automatic refunds or blind replay. Agent rollback preserves claims and physical-outcome uncertainty. Rotate only a compromised independent bridge signing key through its authorized process, not the database or callback keys as a side effect.

## Code ownership and synchronization

The earlier edits already exist in this VS Code folder; they do not live solely in chat. At inspection, HEAD was `3586867` on `repair/neo-waves-20261106`, tracking `origin/repair/neo-waves-20261106`; local HEAD/cached upstream divergence was 0/0. That comparison used cached refs and is not a fresh remote synchronization check. The later edits are working-tree/untracked files, so they are **not** included in that commit or automatically delivered to Lovable.

M-Pesa follow-up files already local:

- `src/lib/mpesa.functions.ts`, `src/lib/mpesa.server.ts`, `src/lib/rpc-manifest.ts`.
- `src/components/payments/MpesaPromptDialog.tsx`, `src/routes/admin.payments-mpesa.tsx`, `src/routes/api/public/mpesa.callback.$token.ts`.
- Modified `src/lib/__tests__/mpesa-server.test.ts`, `mpesa-callback-integration.test.ts`; new `mpesa-connection-boundaries.test.ts`, `mpesa-dispatch-handler.test.ts`, `mpesa-collection-dispatch-postgres.test.ts`.
- New `supabase/migrations/20261112150000_mpesa_collection_dispatch_guard.sql` and `supabase/repair/2026-11-12/MPESA_DISPATCH_READ_ONLY_POSTCHECK.sql`.
- `docs/repair/MPESA-SECURITY-AUDIT-2026-11-12.md`, `PAYMENT-REALITY-CHECK-2026-11-12.md`; local diagnostic scripts `scripts/payment-api-readonly-check.mjs` and `scripts/check-local-server-key-candidate.mjs`.

Other visible local edits from receiving work include `ApprovedReceivingPosting.tsx`, procurement reconciliation route, receiving/business-document tests and migration `20261112160000_atomic_blind_receiving_review.sql`. A changed `supabase/.temp/cli-latest` is tooling state, not part of the proposed integration. These are preserved and should not be swept into a payment/bridge commit without review. `.env.local` was not changed in this investigation.

This investigation adds only this contract. **No bridge implementation has been copied into either codebase.** Prior local tests establish only their stated local scope; they did not cover the missed generic M-Pesa collection path or prove Cloudflare-to-Lovable deployment.

Lovable documents that changes pushed to its active linked Git branch sync back to the project, and its project changes sync to GitHub. Uncommitted local edits do not meet that requirement. Verify the linked active branch before a future normal commit/push; fetch/reconcile without overwriting the dirty workspace, and never rewrite pushed history. [Lovable GitHub synchronization](https://docs.lovable.dev/integrations/github)

Lovable's [Edge Functions](https://docs.lovable.dev/features/edge-functions) and [Secrets](https://docs.lovable.dev/features/secrets) are the intended authorized backend/provisioning surfaces; their availability does not establish that these proposed functions or secrets already exist.

## Precise implementation sequence for both codebases

1. **Original Lovable project:** inspect its deployed source/build, original-domain PIN broker behavior, installed RPC definitions/RLS and available authorized secret interfaces. Record provenance without exporting credentials. Keep collections off where provider connectivity is unproved.
2. **Shared source:** approve the named user/callback/device/agent contracts above; extract runtime-neutral M-Pesa/domain code and add adapter unit/contract tests. Preserve and review the current dirty receiving/payment changes separately.
3. **Original backend:** implement the three narrow function adapters and verified user/custom-auth gates; add reviewed durable request/claim compatibility work only through the original project's approved database process. Reuse the existing PIN resolver and privileged environment.
4. **Cloudflare codebase:** implement fixed-origin forwarding, same-project user sessions, existing PIN/agent facade compatibility and optional scoped machine signatures only where needed. Convert every M-Pesa UI entry point to the same backend operation. Fail closed before pending-payment creation when a provider is unavailable. Do not implement an export-key endpoint.
5. **Both codebases:** implement and pass scope, duplicate/uncertainty, callback, card/QR assurance, sandbox-isolation and secret-boundary tests. Review separate manual-override and pending-recovery policies; do not use manual confirmation to simulate a collected payment.
6. **Release only after authorization:** verify the active linked Git branch; normally commit/push reviewed source, install approved forward changes, deploy original backend then matching Worker behind flags, preserving old callback URLs and outstanding transaction IDs. Record rollback versions.
7. **Independent-deployment acceptance:** execute the authorized sandbox plan through `neo-preview`, with original-backend/provider/ledger evidence. Enable real collection only after that evidence passes. Until then, report the bridge as **designed, not operational**.

## Mandatory recovery release gate added in the codebase-only pass

The existing 20261112150000 SQL candidate now also disables neo_mpesa_retry_callback, whose old implementation replayed stored callback results without fresh provider verification. The admin UI uses existing server reconciliation and the obsolete callable manifest entry is removed. Install/review this deny before releasing matching callback recovery code; an old original runtime/database must not retain that replay path. Early callbacks are retained for fresh-provider recovery and HTTP 503 requests a retry without assuming one will occur. Guest starts now perform a zero-row gateway preflight before reserving balances. See the current payment reality report for test/build evidence. No runtime flag, backend record, migration or deployment was changed.
