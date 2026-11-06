# NEØ departmental readiness — reconciled 6 November 2026

## Evidence boundary

The attached cloud-browser conversation is supplied prior evidence, not a fresh browser review performed in this chat. It reports serving commit 44389e19. Findings remain open until current deployed evidence establishes a different result. The local checkout and origin-tracking branch now show display fixes committed/pushed as d12f7e2. Their live deployment has not been independently confirmed in this review. Do not infer that they fixed a live error already.

The operational Supabase project contains real hotel operations. The pasted conversation's suggestion to use synthetic transactions at Savanna Crown is not authorisation to write test bookings, orders, payments or journals there. Keep the existing database, storage, PIN broker and PowerShell/GitHub/Wrangler workflow. Mawimbi remains read-only. No data or live settings were changed for this reconciliation.

The two registers measure different things: the supplied conversation reports 84 of 251 individual UAT steps passed; the cropped workflow board reports 30 passed, 28 partial and 87 failed, versus the earlier 88-failure brief. They cannot be converted into one completion percentage. The original register and all original 30 pass identities remain incomplete.

## Present readiness

Usable screens and demonstrated intermediate steps exist across the hotel. Independent operation through a complete reconciled business day remains unproved. The largest gaps are payment/shift/journal consistency, stay/deposit/checkout/room-state consistency, and department handoffs. Neither offline tests nor a successful login certify those outcomes. Existing record quality is a separate issue from functional readiness.

| Department / people | Prior supplied evidence | Current local repair contribution | Remaining exit evidence |
|---|---|---|---|
| Restaurant / waiter, cashier | Order entry and station routing demonstrated; historical till and paid-bill closure defects reported | Printer configuration, discovery and print contracts repaired; receipt/discount/tax requirements tracked | One order, correct station attribution and deductions, active till, one payment/receipt/journal, closed bill; shift close |
| Production / chefs, bar, coffee, pastry | Kitchen lifecycle and one recipe deduction demonstrated; coffee/beer deductions failed, pastry unproved | Standalone entry, tools, scoped station filter and explicit display logout repaired locally; PIN broker preserved | Real employee PIN attribution across all stations, recipe coverage, stock deductions, reconnect and shift handover |
| Front Office / reservations, receptionist, guest | Booking quote reaches final confirmation; reservation, assignment and check-in previously demonstrated | Laundry-to-folio and occupancy-related source/SQL repairs prepared | Deposit agrees across reservation/folio, quote explains totals, charges post once, settlement/checkout and eligible room release; stayover stays occupied |
| Housekeeping / attendant, supervisor | Assignment, cleaning and inspection demonstrated; later Ready room did not become available | Tickable scrolling checklist and occupancy-writer repair prepared | Independent acceptance, checkout eligibility and authoritative Front Office room synchronisation after deployed SQL |
| Procurement / approver, buyer, receiver, storekeeper | Approval, PO and first GRN/stock update demonstrated | GRN journal-result confirmation repair prepared | Replacement guard, issue/return/count/variance and supplier invoice/AP matching |
| Events / coordinator, banquet, heads | Enquiry conversion, package/BEO and manual task progress demonstrated | Requirements retained; no new end-to-end events fix certified | Durable quote lines, confirmation prerequisites, departmental task allocation, deposit/stores/final settlement |
| Laundry and minibar / attendants, Front Office | Processing completed but laundry remained unposted; earlier minibar flow later blocked | Catalogue-priced atomic intake, posting retry and handover SQL/source repaired and fixture-tested | Apply only reviewed laundry SQL after preflight; prove handover, one folio charge/journal and fresh minibar regression |
| Maintenance / technician, independent supervisor | Work progression demonstrated; premature manager closure reported | Guarded completion, independent verification and room handback SQL/source repaired and fixture-tested | Verify actual deployed definitions, independent sign-off, one history event and safe room release |
| Finance / cashier, accountant, night auditor | Payment/receipt and one balanced journal previously demonstrated; six blocked and one failed posting reported | Finance/receipt inventory SQL prepared; existing inclusive-tax calculation identified and preserved | Trace exceptions without blind replay, exact balances/tenders/journals, active till/shift, business-day close and next-day open |
| Delivery / dispatcher, rider, guest, cashier | Till verification panel reported missing queue RPC; dispatch/STK not proved | Claim SQL installed and postchecked; live Owner queue read now passes with an empty queue; 32 isolated database checks passed | Diagnose deployed RPC/schema/grants first; then dispatch/rider completion and separate sandbox STK callback/idempotency/reconciliation |
| Administration / owner, heads, staff | Login/configuration/document screens demonstrated; dashboard retry reported | Password-reset route, device capability, Back, local fonts, install acknowledgement and chooser transition repaired locally | Verify deployed build, role denial/isolation, physical printing, duplicate departments/shift time and reconciled reports |

“Prepared SQL” means available reviewed repair files with fixture evidence. It does not mean applied to operations. The prior successful staff/PIN migration is a separate historical fact and must not be replayed.

## Confirmed source investigation: delivery M-PESA queue

The UI in src/components/finance/DeliveryTillVerification.tsx invokes neo_delivery_mpesa_till_claim_queue with no arguments. The historical definition in 20261026163000_p16a_delivery_mpesa_till_claims.sql declares the same zero-argument function and returns JSONB. Therefore the inspected checkout does not show an argument mismatch for that call. Its historical body enforces finance/admin permission and organisation/branch scope. Do not replace it with an unrestricted table query or broad grants.

46_READ_ONLY_DELIVERY_MPESA_PREFLIGHT.sql inventories the exact zero-argument signature, overloads, definitions, effective API-role execute/schema rights, prerequisite functions and schema/policies. It invokes no payment function and reads no operational claim rows. NULL PostgREST settings are unknown, not proof of missing exposure. Both missing-function and present-function/grant branches passed an isolated PGlite check. Live cause and repair remain undecided until these results are reviewed. Never blanket-push migrations or replay the historical claims migration on this evidence alone.

Manual customer Till-code verification is not STK Push. A functioning claim queue cannot certify initiation, provider callbacks, settlement or duplicate callback handling.

## Five priorities

1. Establish deployed parity: inspect the current build and run the separate read-only SQL preflights; reconcile only the applicable scoped backend repairs. The new display batch passed 3,667 offline tests, zero failures, 155 skips and retained all 3,642 previous passes; this is source evidence only.
2. Repair and prove one restaurant financial close, including correct till/shift, stock, receipt, journal and closed bill. Preserve price/tax/discount and historical reprint facts. Use an approved isolated test boundary for transactions.
3. Repair and prove one complete guest stay: transparent quote, reservation/deposit, check-in, folio, settlement, checkout and housekeeping room release, plus occupied-stayover protection.
4. Prove individual-role handoffs across displays, maintenance, laundry, events and procurement. Verify permissions, employee attribution, retries and reconnection; protect the original 30 working workflows.
5. Resolve delivery RPC and finance exceptions with evidence, prove STK separately in a provider sandbox if required, then reconcile a full business day through night audit. Physical printing and real-device installation remain explicit evidence requirements.

Do not run synthetic money/stock/stay tests in the operational property merely because it was called a certification property in an older review. No new external provider, database or storage migration is introduced by this plan.
## USER-CONFIRMED INSTALLATION — postcheck received

The user supplied the SQL Editor Query succeeded screenshot and delivery-mpesa-install-postcheck-v1 result with installation_verified=true. All five checks passed: exact new function contracts, unchanged existing functions, payment uniqueness index, evidence constraints and table access. Four new functions match their expected fingerprints; all 14 supplied prerequisites remain unchanged. Anonymous execution is denied; authenticated execution is limited to the three intended RPCs, with the evidence checker private. The submitted SQL matches the prepared file after excluding the first comment line's text-encoding difference.

Status: SQL INSTALLED AND POSTCHECKED, based on user-provided evidence. Do not run 60_APPLY_DELIVERY_MPESA_CLAIMS.sql or its equivalent migration again. The earlier missing/ready sections describe the preceding diagnosis and preparation, not the present installation state. Migration-history bookkeeping has not been confirmed. The live authenticated queue/API read, guest submission, independent merchant approval and payment/receipt/invoice/journal end-to-end workflow remain unverified; STK Push remains separate. No synthetic operational transaction is authorised by this installation confirmation.
## Live queue verified; narrow UI follow-up

The agent's read-only signed-in browser check of /finance/payments at Savanna Crown Nairobi loaded the M-PESA verification panel with the valid empty-queue message and no missing-function error. No claims, approvals or payment/stock/stay writes were made. The public auth page separately served source fingerprint fcad40292a145382, matching the previously verified display batch; it returned HTTP 200 and private/no-store. This establishes the current queue/read UI under the Owner role, not a payment or STK end-to-end pass.

Two follow-up local source repairs address the observed JSON-quoted home value bypassing the entrance frame and binary decimal multiplication rejecting valid verified amounts such as KES 0.29. 45 focused UI assertions and typecheck passed; production smoke status is recorded in live-mpesa-queue-and-ui-followup-2026-11-06.md. These two changes are not yet deployed. The installed SQL does not need rerunning. Future financial workflow tests must respect the real-operational-data boundary.
