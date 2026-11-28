# Delivery M-PESA claims — scoped repair ready for SQL Editor

## Confirmed live evidence

The supplied read-only catalogues establish that the claims table and submit/queue/approve functions are absent, while the existing delivery accounting routine and organisation/permission helpers are present. This is a missing installation, not merely PostgREST cache lag. The canonical payment function already includes payment retry and cash-shift changes and must not be replaced with an older draft.

## Prepared installation

Run 60_APPLY_DELIVERY_MPESA_CLAIMS.sql once as ONE complete SQL Editor submission in the same existing project. It is a write/DDL installation, not another read-only preflight. It creates the missing claims table, customer submission, scoped finance queue, merchant approval and a private evidence checker. The table has RLS and no direct anonymous/authenticated client access. Only the three intended RPCs are granted to authenticated; their ownership/role/property checks still apply. No role memberships or existing permission grants are changed.

The transaction guards all 14 supplied prerequisite function definitions and 196 required columns, refuses pre-existing claim objects and uses bounded lock/statement timeouts. If a guard fails, stop and share the error; do not remove it or execute the remainder separately. If the editor retains an aborted transaction, issue ROLLBACK before further work. A repeated install deliberately refuses to overwrite existing claim objects; inspect the postcheck rather than rerunning historical migrations.

The installation changes no historical orders, invoices, payments, journals, staff PINs or existing accounting functions. It creates functions that perform future business actions only when invoked. Submitting a reference creates an unverified claim and never pays an order. Approval requires independent finance authority, a property-valid receiving account, merchant Till/evidence, and an amount exactly equal to one issued invoice's reconciled outstanding KES balance. A submitter cannot approve their own claim.

Approval delegates to the unchanged deployed neo_delivery_record_payment function. It requires a saved matching payment and receipt, the expected invoice delta, a paid order/invoice and one unreversed posted journal with matching balanced, property-scoped lines. Missing or inconsistent evidence raises an exception, rolling back the database transaction. An exact retry returns the original payment/receipt/journal after checking their saved evidence, without posting again. Altered or reversed evidence fails visibly. Guest submission uses the existing customer ownership identity rather than a staff organisation context.

## Postcheck and migration bookkeeping

After successful COMMIT, run 98_READ_ONLY_DELIVERY_MPESA_POSTCHECK.sql as one submission. Export its single JSON result. Expected: installation_verified=true, with all check fields true. It checks exact new function fingerprints, API privileges, retained prerequisite fingerprints, RLS/client table rights, uniqueness and evidence constraints. It reads no operational payment or claim rows and performs no submission/approval.

The versioned equivalent is 20261106230000_delivery_mpesa_claims_scoped_install.sql. Do not execute it as well as the combined apply file. Do not run the historical 20261026163000 / 20261026164000 drafts or a blanket supabase db push. Only after actual commit and a successful postcheck, the existing linked-project workflow may mark precisely version 20261106230000 applied using migration repair; that bookkeeping command is not the installation itself.

The existing frontend already calls the same submit/queue/approve contracts. No frontend authentication endpoint or Cloudflare infrastructure change is required by this SQL installation. Current source changes remain to be committed/pushed through the existing workflow; no live application deployment is claimed here.

## Verification and practical limits

32 isolated PGlite checks passed from the actual source script scripts/test-delivery-mpesa-claims.mjs. The fixture executes the supplied canonical payment, journal posting, numbering, account validation and permission definitions. Context helpers, surrounding integrations and minimal supporting tables are fixtures; it is not a clone of the operational environment. Tests cover drift/repeat refusal, guest ownership without staff context, organisation/property/role isolation, client access denial, invoice/amount/account rules, real posting, exact retries, reference reuse, closed period failure, late evidence failure with payment/journal/invoice rollback, recovery, reversed evidence and the single-result postcheck. All 14 existing prerequisite definitions remain unchanged.

Existing posted references in both payments and pos_payments are checked. The claim table and claim locks prevent duplicate approval within this flow. Other payment entry points do not all participate in this advisory lock; global cross-channel concurrent reference uniqueness is not certified by these fixtures and needs coordinated payment-layer evidence. No new global index/trigger was imposed on existing operational payments.

This is manual merchant Till-code verification, not STK Push or automatic bank/provider confirmation. Merchant Till/evidence are recorded, not checked against an external provider. Sandbox STK callbacks, all live trigger/notification interactions, reconciliation through shift/day close and ordinary-user end-to-end UAT remain unverified. Do not create synthetic hotel transactions in the operational property. The original 87/88 outcomes and 30 prior passes remain tracked separately; installation alone does not promote any to a live pass.

No operational database changes, payment approvals, bookings, STK prompts or data cleanup were performed by the agent. The SQL package is ready for the user's existing SQL Editor route.
## USER-CONFIRMED INSTALLATION — postcheck received

The user supplied the SQL Editor Query succeeded screenshot and delivery-mpesa-install-postcheck-v1 result with installation_verified=true. All five checks passed: exact new function contracts, unchanged existing functions, payment uniqueness index, evidence constraints and table access. Four new functions match their expected fingerprints; all 14 supplied prerequisites remain unchanged. Anonymous execution is denied; authenticated execution is limited to the three intended RPCs, with the evidence checker private. The submitted SQL matches the prepared file after excluding the first comment line's text-encoding difference.

Status: SQL INSTALLED AND POSTCHECKED, based on user-provided evidence. Do not run 60_APPLY_DELIVERY_MPESA_CLAIMS.sql or its equivalent migration again. The earlier missing/ready sections describe the preceding diagnosis and preparation, not the present installation state. Migration-history bookkeeping has not been confirmed. The live authenticated queue/API read, guest submission, independent merchant approval and payment/receipt/invoice/journal end-to-end workflow remain unverified; STK Push remains separate. No synthetic operational transaction is authorised by this installation confirmation.
## Live queue verified; narrow UI follow-up

The agent's read-only signed-in browser check of /finance/payments at Savanna Crown Nairobi loaded the M-PESA verification panel with the valid empty-queue message and no missing-function error. No claims, approvals or payment/stock/stay writes were made. The public auth page separately served source fingerprint fcad40292a145382, matching the previously verified display batch; it returned HTTP 200 and private/no-store. This establishes the current queue/read UI under the Owner role, not a payment or STK end-to-end pass.

Two follow-up local source repairs address the observed JSON-quoted home value bypassing the entrance frame and binary decimal multiplication rejecting valid verified amounts such as KES 0.29. 45 focused UI assertions and typecheck passed; production smoke status is recorded in live-mpesa-queue-and-ui-followup-2026-11-06.md. These two changes are not yet deployed. The installed SQL does not need rerunning. Future financial workflow tests must respect the real-operational-data boundary.
