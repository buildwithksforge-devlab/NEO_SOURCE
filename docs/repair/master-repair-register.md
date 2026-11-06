# NEØ master repair register — 6 November 2026

## Fixed working lane

Work in the existing local source checkout through PowerShell. Keep the current Supabase database, authentication and storage, existing GitHub repository and existing Wrangler/Cloudflare deployment method. There is no infrastructure migration or second operational database in this scope. Checkpoint 44389e1 has been pushed and deployed through the existing neo-preview Wrangler script; the later display-entry batch is still local. No operational SQL has been applied by these repair runs. Recovered prior chat history reports the original staff/device migration succeeded before this batch; do not replay it.

All original 88 failures, the additional partial/unproven outcomes and the original 30 passed workflows remain in scope. The incomplete screenshots report 87 failed / 28 partial / 30 passed and do not supply the full original register. No original failed outcome is certified closed on the deployed application by offline source tests alone.

## Business waves and shared requirements

| Track | Implemented source work / current evidence | Remaining outcome gates |
|---|---|---|
| Wave 1: trustworthy state and writes | Occupancy-preserving housekeeping writer; GRN posting confirmation; delivery retry identity; durable print responses; dedicated device capability | Deployment parity, business-day recovery, role/isolation proof and all original 30 live regressions |
| Wave 2: one guest stay | Atomic priced laundry and folio linkage/retry; verified maintenance closure and safe room handback | Full stay, guest requests, assets/parts, linen, minibar/room-service charges, settlement/checkout/receipt/turnover |
| Wave 3: four-station sale | Central printer setup, owned local discovery/agent and correct job claim/finish contracts | Saved/routed production lines, recipes/stores/concurrency, discounts/tenders, one balanced settlement and physical receipt; new finance requirements below |
| Wave 4: stock/AP/day controls | GRN retry boundary repair | Demand/custody, approved receipt, invoice matching/AP, tills/day close, provider callback and ledger reconciliation; new finance requirements below |
| Wave 5: post-basic-launch scope | Delivery intake identity and printer integration support parts of this track | Full events, delivery, reciprocal Mawimbi isolation and physical printer gates |
| Shared UI/install | Applied Back controls, tickable scrolling checklist, browser install flow, document cache policy and actual-source build identity | Final patched-source gate completed below; real-device install/update and contextual public/rider navigation checks remain |
| Local dependencies / hidden actions | Nine bundled font families, three new choices; local-first metric/automation summaries; guest reset URL/error handling corrected | Owned PIN function deployment/cutover in the same project, canonical URL cleanup, development-tool advisory work, remaining page-action audits |

The maintenance gate passed 3,598 offline assertions. The first UI gate passed 3,631 and built successfully. The following source run passed 3,637 offline assertions; its router dependency mismatch was fixed and the aligned production build/smoke passed. Five new guest password-reset assertions pass separately. The final combined source gate protected all preceding 3,637 passes and completed; its result is recorded below. Operational promotion still needs live evidence. These are assertion counts, not live workflow completion counts.

## Added accounting/tax/receipt requirements

These identifiers are new requirement references, not invented replacements for the original UAT IDs. They extend the existing POS, billing and Finance paths. No duplicate accounting module is to be created.

| Requirement | Required behavior | Owning wave / acceptance evidence |
|---|---|---|
| FIN-R01 Inclusive prices | A configured selling price remains the customer payable price. Extract applicable included VAT/CTL; company-configurable rates and product applicability. No blanket CTL. | W3/W4: KES 120 stays 120; VAT-only, CTL-only and untaxed products; persisted lines, receipt and tax liabilities agree. |
| FIN-R02 Discounts | Company-specific enabled state, fixed/percentage limits, product/category/bill scope, combination rules and approvals. Preserve existing Operations Manager up-to-15% / Owner-above-15% authority where configured. | W3/W4: approved and denied ordinary roles, tenant isolation, discounted gross and recalculated included taxes, audit and journal proof. |
| FIN-R03 KES/USD display | Kenyan companies account primarily in KES and display a USD equivalent from an Owner-approved configured rate. Snapshot that rate per transaction; historical reprints retain it. No external market-rate API or second sale is required. | W3/W4: deterministic rounding, changed current settings do not change an old receipt, no duplicated revenue. |
| FIN-R04 Payment settings | Use active company-owned cash/M-Pesa/bank/card/other instructions, never hard-coded Mawimbi details. Show actual tender, received amount, balance, change and references, including split payments. | W3/W4: bill/payment/shift/account references and amounts reconcile. |
| FIN-R05 Receipt layout | Existing receipt integration; company/branch/PIN/contact, transaction/table/room identifiers, item code/quantity/inclusive unit price, included taxes, discount, KES/USD totals, tender, staff and print time. Support 80 mm and supported 58 mm layouts. | W3/printing: readable wrapping and aligned amounts, saved payload, exact document identity and physical output. The referenced Mawimbi Jiko sample image is not attached in this new text. |
| FIN-R06 Accounting | Separate net revenue and tax liabilities; discounted included taxes reduce correctly; actual settlement accounts; deposits/unpaid/partial settlement; correct reversal of voids/refunds/cancellations. | W4: balanced journals, revenue/tax/tender/AP reports and cashier/shift reconciliation for the same source records. |
| FIN-R07 Print safety | Printing/reprinting must not mark a bill paid, repost a sale, create another tender/journal, or alter historical FX/tax facts. Distinguish bill/invoice from payment receipt. | W3/W4: before/after record counts and totals plus controlled retry and reprint proof. |
| FIN-R08 System consistency | POS, restaurant, bar, rooms, events and other selling points use consistent configured pricing/tax/discount facts through their existing paths. | W2/W3/W4/W5: neighboring green flows and all original 30 regression outcomes remain protected. |

Initial source inspection: `src/lib/pos-data.ts` already extracts a combined included tax using `gross * rate / (100 + rate)` and saves the gross line total. This is existing behavior to preserve, not proof of end-to-end VAT/CTL correctness. The existing controlled-finance migration includes server discount authority. The canonical thermal renderer takes financial facts from `neo_document_payload`; changes must connect that payload to settlement/accounting rather than calculate a conflicting receipt-only total.

Money must reconcile in minor units. The illustrative 120 / 1.18 calculation has a rounding residual: independently rounded components can differ by one cent. The implementation needs one deterministic allocation rule so displayed net plus applicable taxes equals the exact payable gross; no extra cent is charged to the customer. The brief's rates are requested configurable business inputs, not a declaration that every product or company has the same legal treatment.

## Evidence rules and constraints

- Use isolated fixtures/test organisation for synthetic financial tests. Do not modify live Mawimbi data or use the operational database for synthetic transactions.
- Preserve source IDs and intentional retry identities; a new business transaction gets a new identity.
- Prove access, action, durable persistence, audit, downstream consequences, reconciliation and isolation before marking an outcome passed.
- Database changes, if needed, remain versioned SQL Editor repair scripts for the same current project, with read-only preflight and postchecks. Do not rewrite historical transactions automatically.
- Deployment stays behind backend parity and the existing protected Wrangler checks. Native/store packages and all 88 live outcomes remain uncertified.

Detailed wave state: NEO-WAVE-STATUS-2026-11-06.md. Local dependencies/page-action findings: LOCAL-FONTS-AND-API-DEPENDENCIES.md. SQL run order: sql-editor/README_RUN_ORDER.md.

## Additional inspected finance connections

Existing company regional settings already expose pricesIncludeTax and default it to true. Existing Finance tax-code settings include rate/effective-date and levy treatment. These must be reused and connected to product applicability, not duplicated. The reviewed POS payload labels one combined tax total; separate VAT/CTL facts and historical USD rate snapshots are not yet verified. The thermal renderer is explicitly built around an 80 mm roll; 58 mm output requires review rather than an assumed pass. The latest local settlement function separates confirmed from pending tenders and preserves partial/prepaid service states. Some pre-existing local migration files are explicitly labelled DO NOT DEPLOY; they are inspection evidence, not instructions to run all migrations against operations.



## Completed UI/font/local-summary source gate

Final patched-source gate: 3642 passed, 0 failed, 155 skipped; all 3,637 preceding passes retained, including the 3,598 maintenance-baseline passes and all 3631 first-UI-batch passes. Typecheck, isolated device catalogue, 14 local print-agent checks and production build/smoke passed. Built / and /auth documents also passed private/no-store, source-identity and local-font checks. No operational SQL, push or deployment was performed. Live wave exits, original 30 workflow reruns and real-device installation remain unverified.
## Current display-entry batch and recovered staff history

The original staff/device migration was reported successful in the earlier Open Local Vite Test chat after correcting the audit logger correlation argument to text. Commit 896fb78 deliberately connected staff PIN through the deployed broker. Preserve that working connection; the direct Edge Function 404 is not proof it is broken. Do not rerun the old staff migration or blanket-push historical migrations.

Local changes now separate property/mode entry from the OS dashboard frame, fix the chooser-to-dashboard hook transition, open display tools without logout, add a separate local display logout, restrict station choices to paired scope, support compact spacing and persist installation/device acknowledgement. No SQL is needed for this batch. Original business-wave exits, finance/receipt work and the original 30 live regressions remain outstanding. F10 is source-repaired, not live-certified.

The new offline gate passed 3,667 tests with zero failures and 155 skips, preserving all 3,642 prior passing assertions. The isolated device catalogue and 14 printer-agent checks passed. Synthetic Chrome checks at 360 and 1440 pixels passed. Production build verification is recorded in the separate PIN-HISTORY-AND-DISPLAY-FLOW-2026-11-06.md report.
## Delivery M-PESA scoped repair prepared after deployed catalogues

The received read-only exports confirm a missing claims table and submit/queue/approve functions, with the existing canonical delivery payment routine present. The new 60_APPLY_DELIVERY_MPESA_CLAIMS.sql installs only the missing feature with drift guards; 98_READ_ONLY_DELIVERY_MPESA_POSTCHECK.sql verifies one exportable installation result. Version: 20261106230000. Do not replay the old drafts or blanket-push migrations. The apply file is DDL/write SQL; neither it nor any payment action has been run by the agent. Existing accounting and staff/PIN functions are preserved.

32 isolated checks passed using supplied real accounting definitions with fixture context/surrounding integrations. Guest ownership, scoped finance access, independent merchant evidence, invoice/payment/journal reconciliation, safe retries and late-failure rollback are covered. This does not certify full live trigger parity, global concurrent payment-reference uniqueness across other entry points, STK Push or shift/night-audit closure. No original failed workflow was promoted to live pass. See DELIVERY-MPESA-CONFIRMED-GAP-2026-11-06.md / the matching source repair note for installation order and practical limits.
## USER-CONFIRMED INSTALLATION — postcheck received

The user supplied the SQL Editor Query succeeded screenshot and delivery-mpesa-install-postcheck-v1 result with installation_verified=true. All five checks passed: exact new function contracts, unchanged existing functions, payment uniqueness index, evidence constraints and table access. Four new functions match their expected fingerprints; all 14 supplied prerequisites remain unchanged. Anonymous execution is denied; authenticated execution is limited to the three intended RPCs, with the evidence checker private. The submitted SQL matches the prepared file after excluding the first comment line's text-encoding difference.

Status: SQL INSTALLED AND POSTCHECKED, based on user-provided evidence. Do not run 60_APPLY_DELIVERY_MPESA_CLAIMS.sql or its equivalent migration again. The earlier missing/ready sections describe the preceding diagnosis and preparation, not the present installation state. Migration-history bookkeeping has not been confirmed. The live authenticated queue/API read, guest submission, independent merchant approval and payment/receipt/invoice/journal end-to-end workflow remain unverified; STK Push remains separate. No synthetic operational transaction is authorised by this installation confirmation.
## Live queue verified; narrow UI follow-up

The agent's read-only signed-in browser check of /finance/payments at Savanna Crown Nairobi loaded the M-PESA verification panel with the valid empty-queue message and no missing-function error. No claims, approvals or payment/stock/stay writes were made. The public auth page separately served source fingerprint fcad40292a145382, matching the previously verified display batch; it returned HTTP 200 and private/no-store. This establishes the current queue/read UI under the Owner role, not a payment or STK end-to-end pass.

Two follow-up local source repairs address the observed JSON-quoted home value bypassing the entrance frame and binary decimal multiplication rejecting valid verified amounts such as KES 0.29. 45 focused UI assertions and typecheck passed; production smoke status is recorded in live-mpesa-queue-and-ui-followup-2026-11-06.md. These two changes are not yet deployed. The installed SQL does not need rerunning. Future financial workflow tests must respect the real-operational-data boundary.
