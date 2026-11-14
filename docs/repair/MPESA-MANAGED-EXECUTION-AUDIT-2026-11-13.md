# NEØ M-Pesa execution-boundary investigation — 13 November 2026

## Finding

The same database is reached through two different authority paths. A user JWT can run scoped configuration/start/read routines, but cannot replace server-only credential access, dispatch claiming or result application. The Worker still uses a local service-role client for these privileged steps. The reported Invalid API key is a gateway rejection before RLS, not a reason to loosen RLS. The Lovable-managed key is inaccessible outside its managed backend; obtaining it is not this repair's solution.

With NEO_LOVABLE_BRIDGE_ENABLED=true and NEO_LOVABLE_BRIDGE_PAYMENTS_ENABLED=false (user-reported deployed values), the existing fixed-origin bridge relays settings and OAuth tests but deliberately refuses mapped money-changing operations. Its authentication-shape check is not authorization: the original managed handler must verify the caller JWT, tenant and permissions. Stable function IDs prove routing identity, not equivalent safeguards or installed SQL.

## Traced paths

| Entry | User-scoped work | Privileged work / boundary |
|---|---|---|
| Settings | get/save use neo_mpesa_settings_get/save under caller JWT | Read is relayed. Save stays on the scoped local RPC; it does not need a service-role substitution. |
| Connection test | settings authority and organisation lookup | Saved credentials use loadMpesaCredentials → supabaseAdmin. The mapped test can run at the managed host; a complete draft OAuth test avoids this read but does not certify saved credentials or collections. |
| Staff POS/folio collection | MpesaPromptDialog → chargeWithMpesa → neo_mpesa_collection_start | Load credentials, neo_mpesa_claim_dispatch, Daraja OAuth/STK, tracking updates and neo_mpesa_apply_result require trusted server execution. The mapped bridge payment is blocked at 503 under the reported flag. |
| Delivery collection | checkout → chargeDeliveryWithMpesa → neo_delivery_guest_mpesa_start | Same privileged preflight/credential/claim/dispatch/recording path. Mapped but gated. |
| Guest folio/deposit | guest ordering/booking → chargeGuestFolioWithMpesa or chargeGuestDepositWithMpesa → ownership-scoped database start | Their exports were absent from the inspected managed build. Previously they bypassed the bridge and tried local privileged access. This repair explicitly blocks that fall-through in bridge mode; it does not invent upstream authorization. |
| Safaricom callback | POST /api/public/mpesa/callback/<tenant token>, no staff session JWT | Not part of the server-function relay. Local callback token lookup → tenant/checkout lookup → saved credentials → Daraja STK query → matching amount/merchant/result → service-only neo_mpesa_apply_result. A Worker callback still needs an authorized trusted executor; settings/OAuth relay does not provide one. |
| Staff reconciliation | caller-visible transaction + neo_mpesa_can_collect | Query provider, save query time, apply verified result through local privileged client unless mapped relay is enabled and verified. |
| Platform integration test | runProviderTest checks integration edit authority and records evidence | Its Daraja branch also loads credentials locally; it is outside the M-Pesa-specific relay. A generic authentication badge is not payment execution evidence. |
| Receipt settlement | provider application routine locks transaction and applies financial changes atomically | POS payment confirmation → pos_reconcile_settlement_internal and delivery completion; folio payment confirmation → allocation/balance; reservation deposit follows its dedicated path. Installed contract and journal evidence must be verified on the original project. |

## Local repairs

- src/server.ts: recognize the two known but unverified guest payment IDs and fail closed without a local privileged fallback, even if someone enables the general payment transport flag. No arbitrary proxy, callback forwarding or production flag change was added.
- src/lib/mpesa.server.ts: remove the obsolete instruction to retrieve/replace the managed service-role key. Saved-credential execution must be placed in the verified managed backend.
- src/lib/mpesa-application-result.ts: require an explicit applied or duplicate result with the terminal status matching the provider result; an HTTP-success RPC is not enough.
- src/routes/api/public/mpesa.callback.$token.ts: unresolved, empty, contradictory or business-failed application results now remain retryable errors rather than being acknowledged as completed.
- src/lib/mpesa.functions.ts: reconciliation applies the same confirmation rule and rejects a different provider checkout/merchant reference before applying money.
- Focused tests extend callback, reconciliation, bridge and credential-boundary coverage. Existing dispatch idempotency, uncertain-response retention, credential redaction and database tests remain in the focused run.

The shared client.server.ts dependency remains for legitimate trusted-runtime callers. Replacing its key with a publishable key or exposing privileged operations to authenticated browser callers would not repair this boundary safely.

## Existing managed-backend route: what is established

There is an existing authenticated, fixed-host route for a subset of operations. There is NOT yet evidence of a complete authorized bridge for guest collection plus token-authenticated callbacks. Prior repository investigation reports the managed backend lacked neo_mpesa_collection_start and neo_mpesa_claim_dispatch and used older dispatch code. That is a concrete parity blocker. It was not re-certified against live schema in this local-only investigation.

The source bundle alongside this report targets the existing project only. It is not another payment system or Supabase project. Its SQL files are candidates, not permission to run every migration or rewrite old payment attempts. Review installed definitions and prerequisites before any application; the dispatch candidate deliberately prevents resending old pending/unknown attempts.

## Minimal remaining managed-side work

1. Verify the original managed runtime can perform its existing privileged operations internally, without exporting its managed key. If it cannot, use an authorized server execution facility inside the same project rather than a browser proxy or a new project.
2. Synchronize the reviewed M-Pesa handlers/callback and exact missing database contract into that runtime. Confirm all required staff/delivery/guest exports and their authorization paths. Source IDs alone do not prove implementation parity.
3. Ensure the configured callback base reaches that verified executor, preserving the existing tenant token and checkout matching. Do not rotate secrets or silently redirect in-flight callbacks.
4. Verify authorized/denied/expired/cross-tenant calls and a controlled sandbox STK → provider-verified callback → one receipt/allocation/settlement/journal, including retries and ambiguous timeouts.
5. Only then review the Worker payment gate and guest allowlist for enablement. Do not turn the payment flag on merely because OAuth passes.

No GitHub access, new project, live STK charge, production flag change, credential retrieval, schema installation, deployment or real-money payment was performed. Five Lovable credits are not a verified deployment budget; no paid Lovable action was invoked.

## Verification

Focused M-Pesa/relay run: 133 passed, 0 failed, 0 skipped across17 reported suites. Full TypeScript check passed. Production build and built-app smoke verification passed. All7 compiled relevant function IDs match their explicit bridge classification. No deployment was performed. A real M-Pesa payment has NOT been confirmed end-to-end.
