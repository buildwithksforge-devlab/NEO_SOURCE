# NEØ position, workflow matrix and ten-day implementation plan

Review date: 13 November 2026, Africa/Nairobi. **Current local repair and departmental verification report. Not live launch certification.**

**Subsequent authorization and progress:** the user then authorized local code repairs and tests, while retaining the prohibition on deployments, credential changes, migration execution and live payment/data actions. The generic POS M-Pesa path and provider readiness are fixed locally and tested. An optional existing-server Lovable relay is implemented locally with 57 focused checks, TypeScript, lint and production build passing, but is not enabled or live-certified; current scope and remaining checks are tracked in [the active execution queue](NEO-LAUNCH-EXECUTION-QUEUE-2026-11-13.md). Findings below describe the review baseline; consult the queue for current implementation status.

## Where the project stands

The departmental operating model in the second pasted text is technically possible with this architecture. This checkout already has shared reservations, folios, POS, recipes, stock, procurement, tills, journals, permissions, events and recovery routines. It is a substantial implementation, but it is not evidence that every operational chain is complete or that the two deployed frontends run the same source.

The immediate blockers are rejected privileged runtime authentication, reported missing atomic M-Pesa routines, source/deployment differences and incomplete workflow acceptance. The recipe system does not need rebuilding, and the original backend does not need replacing to pursue the proposed bridge.

There are three separately versioned things:

1. This VS Code checkout and the frontend/server built from it for `neo-preview`.
2. The original Horizon/Lovable frontend and its privileged app-server handlers. The local Edge Function candidate is not reported deployed there.
3. The shared Lovable-managed database, including routines installed directly through the SQL editor.

Sharing the database does not synchronize the frontends. A database routine installed through SQL Editor does not automatically add a route, import adapter, button or test to either checkout. A local source file or passing mock does not prove the deployed database has the matching definition.

The previously written [Cloudflare–Lovable contract](CLOUDFLARE-LOVABLE-BACKEND-CONTRACT-2026-11-12.md) remains the detailed endpoint/authentication/request/response/security/rollback specification. Its endpoint IDs describe the inspected local build, not authenticated discovery of the original deployed build. **The optional relay is implemented and tested locally; it remains off and undeployed.** Matching public function IDs were subsequently observed, but matching deployed implementation bodies and financial safeguards remain unverified.

## What the first pasted text adds

The supplied Lovable report contains stronger evidence than the earlier local-key check: it reports an authenticated sandbox OAuth test on the original live app and its preview succeeding, while the independent Cloudflare frontend reports the invalid privileged key. It also reports the original backend's managed privileged access succeeding for metadata/count-only checks.

These are **user-supplied reports of checks performed in Lovable**, not checks repeated from this session. They support keeping the original privileged runtime and forwarding narrowly authorized operations to it. They do not establish that STK phone delivery, callback, receipt, bill settlement and Finance posting passed from Cloudflare.

There is no need to keep hunting for or exporting the original managed service-role key. The intended architecture is:

`user session → Cloudflare frontend/server adapter → authorized original Lovable backend → provider/database`

Ordinary user-authorized recipe reads/edits and many operational RPCs can continue using the existing public project client plus the signed-in user's JWT and RLS. Privileged provider/device/agent operations belong in the original trusted backend. Do not replace that privileged client with the public key and do not point NEØ at a different project.

The paste also reports newer Horizon changes: recipe onboarding/import, browser USB/Bluetooth printing, printer-system compatibility and trusted-device/PIN UI. Their exact deployed source, database signatures and release commits were not available in this session. They must be compared with this checkout, not assumed already copied here. The quoted 120 routines/14 tables were reported against that earlier Lovable source snapshot; they are not a freshly established count of omissions in this local tree.

## Recipes: present frontend versus missing newer import

### Already in this checkout

- `/kitchen/recipes` in `src/routes/_shell.kitchen.recipes.tsx`, linked in `src/lib/navigation.ts` as Recipes & Standards.
- `IngredientRows.tsx` and `recipe-master.ts`: repeatable ingredient rows; stock-item/sub-recipe selection; quantities, units and waste allowances; recipe/menu links; direct-stock mappings; yields; station selection; create/update/component actions.
- `recipe-engine.ts`: deterministic per-unit preview and nested recipe expansion with cycle, missing-recipe, bad-yield and unit checks. Preview is not a second stock ledger.
- `useAttachRecipeToMenuItem` and `bindMenuItemConsumption`: attachment hooks and stock-consumption mode selection.
- Backend consumption paths and migrations already represented in the repository; editing the recipe is distinct from actually consuming stock through the canonical inventory path.
- Recipe view/create/approve permission gates and associated local tests are present. These source tests do not establish current staff permissions or live stock outcomes.

The recipe catalogue reads `recipes` and `recipe_ingredients` with the **user-scoped** Supabase client, not the missing privileged server key. Therefore a missing menu entry, permission denial, empty property scope or incompatible schema should be diagnosed on that path instead of automatically blaming the service-role key.

### What is not represented locally

The newer **Hotel Data Onboarding → Recipes** import described in Lovable's update is not registered in the inspected local onboarding domain/adapter catalogue. The local menu onboarding description explicitly leaves recipes/stock links with the menu module. There is no corresponding new recipe import route/adapter implementation found here. The recipe editor's ingredient table is not proof that this onboarding importer exists.

The reported importer accepts one row per ingredient, resolves existing menu/stock items, groups by dish, rejects invalid groups, saves each dish atomically and supports explicit replacement/version activation. Those are claims about the newer Lovable implementation. To bring that here, obtain its actual source and installed backend contract through authorized project interfaces; do not reverse-engineer it from prose and overwrite an operational function.

### Concrete local integrity gap to review during integration

`useApproveRecipe` in `src/lib/kitchen-data.ts` uses separate requests to supersede old active recipes, activate the selected recipe and bind menu consumption. `useAttachRecipeToMenuItem` also updates the recipe and menu binding separately. Recipe form creation saves the master and ingredient sheet in successive actions. A single insert can make the ingredient sheet atomic without making the **entire** recipe/version/menu operation atomic.

This is precisely where the reported newer importer/version-activation correction needs comparison. Do not claim the same atomic guarantees for the local editor merely because ingredient rows save together. A future backend transaction must enforce one active version, correct property/menu mapping and rollback on component/binding failure, while preserving existing recipes and history.

### Frontend parity work required, not performed

1. Inventory the original importer components, onboarding domain/adapter, exact RPC signature and migration/version. Compare menu/stock identifier resolution, role requirements and duplicate/replacement semantics.
2. Bring the reviewed source through the actual linked Git branch or an authorized clean source export. Preserve the dirty local M-Pesa and receiving changes; do not pull/overwrite blindly.
3. Register the recipe import domain and UI locally, using its original grouping/resolution contract. Existing dishes may have any legitimate number of ingredient rows; no fixed ingredient count or guessed stock items.
4. Save per dish in one backend transaction; distinguish create draft, activate reviewed version and explicit replace. Failed/skipped ingredient rows must block the whole affected dish, not create a partial recipe.
5. Test exact unit conversion, whole items, missing master, duplicate ingredient, cross-property mapping, failed-row rollback, repeat import, replacement permission and single-active-version behavior.
6. Separately prove one approved recipe sale creates the correct station ticket, exact configured stock movement, payment/room charge and Finance effect once. No automatic consumption merely because an import succeeded.

## Master workflow and departmental integration matrix

Status definitions: **Present** means source exists, not certified. **Past partial** means recorded earlier workflow evidence, not every variant or today's deployment. **Blocked/gap** identifies a concrete unresolved issue. **Unverified** requires execution/downstream proof.

For every row, release evidence must include canonical source IDs, authorized and denied roles/properties, durable downstream records, no duplicates on retry, and visible recovery. Notifications alone are not downstream completion.

| Workflow / departmental handoff | Authoritative records and effects | Current verified evidence / gap | Required end-to-end acceptance |
|---|---|---|---|
| Reservation / deposit / check-in / folio | Reservations, room assignment, deposits, folios, journal receipts | PARTIAL LOCAL EVIDENCE: check-in eligibility/source contracts 27; reservation monetary boundaries 35; deposits 8; receipt/journal database fixture 2 pass. These do not execute the full live stay. | One authorized reservation/deposit/check-in, correct outstanding balance and allocation, occupied room, one folio and journal; denied property, partial/repeated/cancelled variants. |
| POS sale / kitchen-bar production / settlement | Orders/items, station tickets, payments, stock movements, journals | PARTIAL LOCAL EVIDENCE: route/role/recipe contracts exist; no complete current POS-to-production-to-stock-to-Finance sale was executed in this audit. | One correct property/station ticket, preparation/service, valid tender or room transfer, exact recipe/direct stock and accounting effects once, eligible closure. |
| M-Pesa / callback-query / bill-till-Finance | STK server handlers, mpesa_transactions, module payment, callback events, apply routine | LOCAL REPAIRS TESTED: 131 payment checks; direct stored-callback replay disabled in candidate SQL; guest server preflight and early-callback recovery added. LIVE BLOCKED: rejected key, reported missing start/claim routines, relay off. | Review/install matching SQL and original handlers, connection-only relay acceptance, sandbox STK and verified callback, exact amount/receipt, one settlement/till/journal; no real production charge during audit. |
| Integrated card / QR collection | Provider intents, attempts, linked POS/PMS payment, callback | GAP: current-dialog duplicate lock and property propagation tested; record/intent creation still separate, old pending recovery and real acquirer unproved. M-Pesa relay does not cover these providers. | Real acquirer sandbox/merchant matching, authorization/capture and callback, atomic headroom/intent boundary and safe uncertain-outcome recovery. |
| Cash / standalone card slip / bank transfer | Till request, drawer/shift, payment, account, receipt, journal | PARTIAL LOCAL EVIDENCE: UI/recorded-tender tests and controlled Finance contracts pass. No electronic debit is performed by these recorded tenders. | Physical/bank evidence, intended cashier/drawer/account, correct amount/change, one traceable receipt/register/journal; replay and denied role. |
| POS room charge / guest folio / Finance | Order, active folio line, posting receipt, journal and source state | LOCAL DATABASE FIXTURE PASS: 36 actual supplied posting/receipt/GL repair checks. Fixtures substitute surrounding context; live installation and full operational chain remain open. | Current installed definitions, authorized active stay, single charge/folio/journal link, no direct POS revenue duplication and no extra stock consumption. |
| Checkout / Housekeeping / room availability | Reservation/stay, room occupancy, housekeeping job, availability read models | LOCAL DATABASE FIXTURE PASS: 47 readiness checks and 22 occupancy/housekeeping PostgreSQL checks; workflow/template contracts also pass. No live checkout-to-cleaning rehearsal. | Settled eligible checkout, dirty/task handoff, correct cleaner/inspection, room withheld until ready; reconnect/retry and overdue-stay protection. |
| Maintenance / parts / independent room handback | Work order, hold, status history, room state, stock/cost records | LOCAL DATABASE FIXTURE PASS: 18 release/closure checks; parts procurement/consumption and complete live maintenance-finance chain not certified. | Repair evidence and independent supervisor verification, no self-release, correct hold/occupancy/dirty-room outcome, traceable parts/cost and no duplicate release. |
| Recipes / import / production consumption | Recipe/version, ingredient/menu links, stock/cost movement | PARTIAL LOCAL EVIDENCE: recipe engine 13 pass. Editor exists; newer importer is absent locally, activation/binding spans requests, no complete recipe sale/stock-cost proof. | Correct units/sub-recipes and variable ingredient counts, one active approved version; failed dish rollback; exact once-only property stock/cost at configured sale stage. |
| Requisition / issue / transfer / return | Requisition, source/destination location, stock transfer and movements | SOURCE/HELPER CONTRACTS PASS: 3 requisition-family, 5 departmental consumption and 28 stores/procurement checks. 18 live inventory-scoping checks SKIPPED without PGHOST. | Authorized issue and destination receipt, partial/cancel/return/retry, correct location quantities and valuation; current database tenant/property isolation. |
| LPO / blind receiving / approval / GRN / stock | PO line, immutable physical count, independent decision, GRN lines and inventory receipt | CONFIRMED FAILURE: real receiving engine refuses 12 delivered/2 rejected/10 accepted against 10 outstanding. 5 review and 3 virtual-guard tests pass with engine substituted, so cannot close this row. | Repair physical-versus-accepted PO counters and posting/reversal contract without erasing rejected quantities; real-core integration, rollback, independent permission and excess-resolution proof. |
| GRN / AP invoice / supplier payment | GRN/valuation, supplier invoice/liability, accrual journal, supplier payment | NOT CERTIFIED: AP deposit policy 3 source checks pass; 5 live GRN-to-Finance assertions SKIPPED without PGHOST. No real accepted-receipt liability/payment chain executed. | One balanced accrual, immutable posting receipt/events, correct invoice matching and supplier liability/payment, traceable reversals and duplicate protection. |
| Refund / return / reversal | Original source/receipt, approval, payout or credit, stock and journal reversal | SOURCE/HELPER CONTRACTS PASS: 13 refund confirmation and 2 journal-sign checks. No actual refund or complete payout/return workflow tested. | Original receipt and independent authorization, verified payout/credit, correct stock and journal recovery exactly once; no refund on uncertain collection. |
| Laundry / guest services / folio | Guest intake, garments, catalogue price, stay/folio link, audit and charge | LOCAL DATABASE FIXTURE PASS: 23 guest-laundry atomic intake/first-folio tests. Full washing/delivery, linen/stock, cancellation and complete Finance lifecycle remain open. | Authorized guest/stay, catalogue pricing, atomic garments/charge, delivered service, correct linen/stock/cost, reversal/retry without duplicate charge. |
| Events / BEO / departmental work / invoicing | Booking, scoped department requirements/tasks, BEO, deposits/invoice | LOCAL DATABASE FIXTURE PASS: 21 ownership/confirmation checks; 6 property contracts pass. Full event stock, invoice, settlement and accounting chain unexecuted. | Authorized owner for every requirement; one task/BEO on retry, retained quote, scoped stock use, one invoice/deposit allocation and journal. |
| Staff PIN / identity / role-property scope | Trusted device hash, PIN resolver, one-time Auth token, staff session | PARTIAL LOCAL EVIDENCE: broker transport behavior and role/template checks pass. Horizon report confirms matching X-Neo-Device-Token contract; real paired-device verifyOtp not tested. | Real authorized employee session, intended work home, expired/revoked/locked/other-property denial and correct ordinary-role authority; no shared admin session. |
| POS / print queue / agent / physical paper | Committed station items, print job, scoped agent, claim and acknowledgement | LOCAL EVIDENCE: 22 print API/database, 8 source contract and 15 Node agent checks pass. Horizon connector differs. Only PDF/OneNote installed; physical paper NOT VERIFIED. | Matching deployed job/token/claim contract, physical printer and actual paper, correct property/station, same claim acknowledgement; unknown physical outcome never auto-reprinted. |
| Collections / till / journals / business-day close | Tender/payment, drawer/shift, journal, exceptions, signed day audit | LOCAL DATABASE FIXTURE PASS: 4 day-close scenarios; controlled Finance contracts 20 pass. No complete current operational shift/day reconciled. | All till/order/refund/remittance exceptions resolved or blocked, matching source/register/journal totals, signed audit, single closure/advance and protected backdating. |
| Live updates / reconnect / notices | Scoped Realtime, operational query cache, notifications | PRESENT: earlier local refresh checks pass; no slowdown introduced. Two-device latency, deployed publication and reconnect acceptance remain open; polling is not universal instant delivery. | Two authorized devices observe committed stock/order/payment changes within agreed bounds; reconnect resync, visible stale state and tenant isolation. |
| HR / payroll / extended operations | Approved payroll/earnings/deductions, Finance posting, released payslips | LIMITED SOURCE EVIDENCE: 2 payroll release-guard checks pass. Full calculation, approval, payment, journal and employee release not certified. | Explicit launch scope; approved calculations and deductions, balanced authorized Finance posting, verified payout and employee-only payslip release; retry/period controls. |

The old 106-item queue records 2 verified closed and 104 with some repair or acceptance work. Its counts are not 104 newly reproduced failures, nor a percentage-complete measure. It predates later uncommitted work and must be reconciled with evidence before using it as a launch scoreboard. Do not erase useful history or mark whole modules done because a unit-test batch passed.

## Current verification evidence and limits

- Departmental batch: 209 tests passed, 18 live inventory-scoping tests skipped. Supplemental batch: 134 passed, 5 live GRN/Finance tests skipped. The 343 passing tests cover helpers, source contracts and isolated routines; they are not 343 completed business workflows.
- Separate isolated SQL scripts passed 36 POS room-charge/accounting checks, 47 room-readiness checks and 21 Events ownership checks. They apply candidate repairs inside local fixtures; these are not current installed-database results.
- Actual receiving SQL reproduced the known 12-delivered/2-rejected boundary failure. It remains a release blocker despite the mocked review suite passing. Its receipt posting updates physical received and accepted counters separately; changing a single wrapper number would lose the rejection trail or corrupt future outstanding quantities.
- Full live inventory and GRN/Finance assertions require an authorized database connection (PGHOST/psql); none was available, so skipped tests remain unverified. No connection key was invented or public-key access promoted to privileged access.
- M-Pesa local payment batch passed 131 tests; callback recovery was subsequently refined and its focused rerun is tracked in the execution queue. Old pending payments were not changed, canceled, confirmed or resent.
- No Lovable prompt was sent. After the user specified local-code-only work, no further original-app UI action was taken. No deployment, migration installation, live payment or operational record mutation occurred.
- Immediate order: finish/verify the local M-Pesa candidate, establish its original-backend/installed-SQL release gates, then use this matrix to address receiving and other actual departmental gaps. Do not mark broad modules complete from screens or unit tests alone.

## Live updates and costs

Your requirement is preserved: do not slow active operational screens, notifications or stock visibility to save credits. No polling, caching, schedules or backend pauses were changed in this investigation.

Current local source evidence:

- `notifications-inbox.ts`: tenant/property-filtered, bounded newest-150 query; `refetchInterval:120_000`, `staleTime:60_000`. The five-minute polling proposal is not the current inbox implementation. Two-minute polling still is not instant notification delivery.
- `operational-query-client.ts`: 60-second fallback for selected operational query roots, with faster explicit query intervals taking precedence and background-tab interval polling disabled. No ten-minute activity-idle cutoff was found in this query-client implementation. This is not a promise about every possible refresh path.
- POS and kitchen use `useScopedRealtime`; `realtime-scope.ts` has organization filters, connection status and reconnect/resync logic. Correct hooks do not prove that every deployed database publication/subscription is enabled or that every affected view invalidates correctly.
- Recipe reads already use the normal authorized public client. Moving frontend hosting to Cloudflare does not eliminate the shared backend or its compute cost.

The pasted historical 28 October–10 November report says 84.86 **requested credits**, including 65.97 Build and 18.89 Run; approximately 77.7% of that reported total was Build. Database compute was 17.90 of 18.89 Run credits, approximately 94.8%. These are arithmetic summaries of the supplied historical report, not fresh invoices, current prices, cash bills or a savings guarantee. Its stated per-day compute estimate must not be treated as a currently verified rate.

Cost work compatible with live operations: bounded/scoped reads, eliminating duplicate reads, measured indexing, appropriate subscriptions and reconnect recovery, and batching reviewed development/deployment changes. Do not pause the operational database, defer alerts, disable essential polling or change notification jobs without a separate operational decision and measured acceptance. Index/storage/compute changes are future changes, not executed here. Supabase documents authenticated database-change subscriptions in [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes); adopting or extending them needs testing, not a blanket claim of free or instantaneous updates.

## What needs external access versus engineering work

**Original Lovable access/provenance is needed for:** its latest frontend/import/print-station source; exact deployed endpoint contracts; original protected runtime configuration; installed SQL signatures/grants; authorized function deployment; and a controlled sandbox payment/device/printer trial. No service-role-key extraction is needed for the recommended architecture.

**Local engineering can do:** compare and integrate reviewed source, implement Worker adapters, unify POS collection entry points, fail closed before misleading pending creation, prepare recipe import adapters and permissions, repair accepted/rejected quantity handling against the actual receiving engine, improve recovery UI and write meaningful isolated integration tests. Under the current design-only instruction, this is a work list, not work silently performed.

**Physical/owner facts remain necessary for:** actual issuing stores/stock quantities, intended staff approvers, merchant/acquirer setup, test handset authorization, printer connectivity/paper output and true goods receipt. These cannot be inferred from code or fabricated test records.

The read-only helper `supabase/repair/2026-11-13/READ_ONLY_FRONTEND_BACKEND_PARITY.sql` inventories relevant table/column names and routine signatures/fingerprints/execute grants without reading business rows or credentials. It is prepared for the original authorized SQL editor; it was not run here. A fingerprint is not by itself proof of correct behavior, and function names alone do not prove compatible signatures.

## Proposed ten-day plan and release gates

This is a priority/acceptance plan, not a promise that every department in the blueprint can be certified in ten days. Dates assume Day 1 is 13 November; adjust to your actual launch date. Keep one clearly designated UAT boundary; no tests against real guests, goods or money without explicit operational authorization.

| Days | Work across the two frontends and original backend | Exit evidence |
|---|---|---|
| 1 — 13 Nov | Establish source-of-truth branch/commits for local, Horizon and Worker. Inventory installed original routines read-only. Obtain latest recipe import/print-station source. Freeze unrelated changes and stop key-extraction attempts. | Written parity map, exact original backend/project confirmed through authorized tools, no pending changes overwritten. |
| 2–3 — 14–15 Nov | Implement narrow original-backend adapters and matching Worker forwarding using original user JWTs/custom device/agent credentials. Unify generic/dedicated M-Pesa entry points; keep old callback URLs and existing transaction IDs. | Scope-denial tests; Worker OAuth reaches the real original backend without a database-key error; one original-project PIN session flow; no privileged secret in browser/Worker. |
| 4 — 16 Nov | Run complete authorized M-Pesa sandbox initiation→prompt→verified callback/query→receipt/register/Finance chain, including timeout/retry/concurrency. Decide explicit fractional-amount and manual-override policies. | Actual sandbox evidence through `neo-preview`, one application and no false manual confirmation. If this gate fails, M-Pesa is not declared live. |
| 5 — 17 Nov | Integrate the actual newer recipe importer; reconcile recipe activation/menu binding and unit/sub-recipe/direct-stock semantics. Verify station issuing-store readiness. | Complete per-dish atomic import and rollback; one approved recipe test sale consumes correct stock once, separate from import success. |
| 6 — 18 Nov | Repair receiving wrapper/engine quantity mismatch, reviewer authority, excess/rejection recovery and GRN/AP handoff. Run actual core engine in local integration tests before controlled UAT. | Matched/partial/rejected/excess and failure cases; one GRN/stock effect and traceable liability; no virtual goods posted. |
| 7 — 19 Nov | Prove room charge, guest settlement/checkout and housekeeping/maintenance availability chain with intended roles. | Correct folio, one charge/journal, dirty/inspection/block readiness; denied and repeated actions safe. |
| 8 — 20 Nov | Verify physical printing and device PIN; run till/shift/business-day reconciliation and any explicitly in-scope refunds. | Paper and claim acknowledgement; no duplicate unknown-outcome reprint; balanced controlled shift/day; separate real-device evidence. |
| 9 — 21 Nov | Cross-property/role negative tests, two-device update latency, offline/reconnect recovery, retained-source regression and operator rehearsal. | No tenant/property leaks, no misleading stale state, all selected launch chains have durable downstream proof. |
| 10 — 22 Nov | Scope-specific go/no-go, backup/rollback verification, operator recovery instructions and controlled launch decision. | Named release commits, installed-schema evidence, verified merchant/printer/device setup, zero unresolved critical integrity/access/payment blockers in the selected scope. |

At the end of Day 3, explicitly review whether the independent-Worker route is on track. The existing original Lovable-hosted runtime may be a contingency hosting option only after its required workflows are verified; successful OAuth alone does not make it operationally certified. A release can be scoped to verified workflows, but must not advertise unverified M-Pesa, payroll, refunds or acquiring as working. An override note is never a substitute for provider payment evidence.

## Exact next implementation sequence for both codebases

1. **Original Lovable:** read-only installed-schema/source inventory and obtain the new recipe/print source plus deployed endpoint contracts. Keep secrets private. Do not reapply all historical migrations to force parity.
2. **Local/shared source:** preserve and review dirty M-Pesa/receiving changes; compare original commits/export; integrate only compatible changes through normal commits on the actual linked branch. No force-push, reset or blind pull. The local edits are already in VS Code; uncommitted files are not automatically delivered to Lovable.
3. **Original backend:** implement the narrow authenticated operations from the existing backend contract; retain authorization, provider verification, lock/reuse/claim/idempotency rules and original callback compatibility. Any needed SQL changes require the normal separately authorized process.
4. **Cloudflare frontend/server:** replace only privileged paths with the backend adapters; fix all payment entry points and provider readiness; wire the actual recipe-import UI and print-station/device protocol where compatible. Ordinary RLS-bound recipe reads keep their user-scoped access.
5. **Both:** execute the matrix's selected release tests, independent-Worker sandbox checks, physical printer/device checks and cross-property negative cases. Record source IDs, receipts, movements, journals and latency; keep failures visible.
6. **Only after authorization and passing gates:** deploy matching original backend/Worker versions using the established protected process; retain old callback URLs and rollback versions. Do not claim the integration works until independent-deployment evidence passes.

Official reference points: [Lovable GitHub synchronization](https://docs.lovable.dev/integrations/github) explains synchronization through the active linked branch; [Lovable Edge Functions](https://docs.lovable.dev/features/edge-functions) identifies the original backend function surface. These documents support the proposed mechanisms, not the claim that the proposed bridge or the reported newer recipe code is already installed here.
