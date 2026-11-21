> Historical snapshot. Current queue and validation: [8 November readiness](NEO-CURRENT-READINESS-2026-11-08.md).

# NEØ repair status — 7 November 2026

The local repair work is progressing. No entire department or wave is certified for independent production operation by the evidence currently available. The latest POS SQL repair is installed and verified by the user-supplied operational postcheck on 7 November 2026.

## Original failures and protected passes

The board reports 87 failed, 28 partial and 30 passed workflows. The earlier brief says 88 failures; that discrepancy remains unresolved. The supplied images expose 71 complete tiles: 33 failures, 15 partials and 23 passes. The remaining 54 failed workflow identities and seven original pass identities are outside the crop. They remain in scope; they are not guessed or marked repaired.

Among the 33 visible failures, eight have mapped source repairs implemented (F03, F10, FO10, FO13, HK06, LN01, MT03, MT04), five are partly addressed (F09, HK08, POS09, FO08, POS10), and twenty lack a completed repair batch mapped in the current evidence. These are source coverage categories, not live UAT closures. No original failure is promoted to a full pass by this report. The accompanying CSV preserves all 71 original statuses and flags the 23 identified original passes for regression protection.

## Current departmental evidence

| Area | What has evidence | What prevents certification |
|---|---|---|
| Foundation, access and displays | Local access/device and entrance fixes; live chooser and entry into OS verified | Role matrix, password recovery, device/display pairing and supervisor/logout transitions need complete live outcomes |
| Front Office | Availability/reservation/check-in baseline passes; room inventory loads; folio/laundry/synchronisation source repairs | Full guest stay through room charges, settlement, receipt and downstream accounting remains unverified |
| Housekeeping and laundry | Occupancy protection, laundry pricing/idempotency and checklist UI repairs; live states load | Cleaning/inspection/rework, occupied-room protection, billing and FO handoffs need end-to-end retest |
| Maintenance | Independent checking and room-handback source repairs; completed work exposes checking action | Independent supervisor verification and ready-room release not exercised live |
| Restaurant, kitchen, coffee, pastry and bar | Queues load; live review showed 50 open and 21 delayed tickets; POS accounting code and three existing receipt links installed and verified | Four-station routing, service, all tenders, stock consumption, receipt and reconciliation require proof |
| Finance and day close | M-PESA claim installation verified; live claim queue reads; three existing receipt-to-folio/journal links verified | Catering posting still failed; night audit has persisted blockers; reconciliation and reversals need outcome evidence |
| Stores and procurement | Views open; durable GRN posting source repair | Requisition approval, receiving, stock/AP matching, supplier payment and reversal handoffs need proof |
| Events and delivery | Views open; scoped manual M-PESA claim functions installed with postcheck | Real merchant confirmation/payment workflow, separate STK, delivery completion and events accounting not certified |
| Printing and installation | Printer configuration is in Configuration Centre; install acknowledgement, local fonts and update/privacy source work | No paired property printing computer or physical receipt proof; native/store releases and real-device validation outstanding |

Wave 1 remains open for trustworthy access/state/write outcomes; Wave 2 for a complete guest stay; Wave 3 for a complete four-station sale; Wave 4 for stock, AP and day controls. Events, delivery, Mawimbi and physical printing remain tracked beyond those core waves.

## Latest installed accounting repair

The supplied read-only export proves three room charges already have balanced posted folio journals. Their POS receipts have lost both folio-line and journal pointers. The package links only those three reviewed receipts to existing evidence; it does not recreate charges or journals. Existing order, folio and journal records remain unchanged in fixture verification.

It also adds the missing `event-catering` alias to the existing Savannah Events Revenue account 4050, preserves other organisations' mappings, verifies durable room-charge evidence on retries, and rejects draft/empty journals masquerading as successful duplicate postings. Existing posted bar revenue classification is not changed by this package and needs a separate reviewed accounting decision.

Validation: 36 isolated PostgreSQL-compatible fixture checks passed from the actual local source. They cover guarded atomic installation, metadata recovery, retained functions, private helper permissions, bad/ambiguous/reversed journal rejection, duplicate prevention, late journal linkage and positive/negative postchecks. No operational connection or synthetic hotel transaction was used. These checks do not establish a live business workflow pass.

The user applied `70_APPLY_POS_ROOM_CHARGE_REPAIR.sql` and supplied the result of `99_READ_ONLY_POS_ROOM_CHARGE_POSTCHECK.sql`: `repair_verified: true`, all six checks true, all three links verified, all six installed definitions matching, and all eleven retained functions unchanged. Do not rerun the installation. This is supplied operational SQL evidence, not a new browser retest. The failed catering sale is deliberately not retried automatically. Confirm its payment evidence and authorised accounting treatment before a financial retry.

Do not rerun the staff/PIN migration or use blanket `supabase db push`. The working PIN broker, existing Supabase storage/database and Cloudflare worker identity remain the current architecture. Migration-history reconciliation, Git push and deployment of this new batch have not been performed.

## Remaining cross-system scope

Keep the finance brief in scope: inclusive VAT/CTL applicability, discount/approval limits, KES/USD rate snapshots, split payments and payment instructions, 80/58 mm physical receipts, journal reversals and print retries without financial reposting. These are not all implemented or certified by the current package. External dependency cleanup must preserve necessary Supabase authentication/storage and actual payment integrations; local alternatives are preferred where they can provide the real function.

Read this report alongside the 6 November fresh cloud review and the per-workflow CSV. Neither page loading, SQL installation nor passing source tests substitutes for role-correct operational evidence.

## Live follow-up after installation — 7 November 2026

The signed-in browser showed November 1–7 posting exceptions: 0 blocked, 1 failed (POS-20261102-XP3WR, KES 4,635). This is the monthly scope; the dashboard's last-30-days counts are a different range. The three prior monthly room-charge blockers no longer appear. The catering order shows a confirmed Cash payment of KES 4,635, paid KES 4,635 and zero balance. Two items remain accepted/sent, and the page says preparation prevents bill closure. No payment, Retry, service completion, backfill, or other operational mutation was executed.

The monthly revenue reconciliation also displays an approximately KES 203.15 million difference, including very large open/draft/ready source amounts. This requires investigation of lifecycle inclusion and source data; it is not certified realised revenue or a proven cash loss. The dedicated exception register clearing does not resolve that separate reconciliation issue.

Next evidence: 71_READ_ONLY_CATERING_RECOVERY_PREFLIGHT.sql, validated to return one scoped read-only result in the isolated fixture, checks current tender rows, existing journals and settlement mapping definitions. Await the operational JSON before selecting a ledger recovery. The prior 36 repair assertions remain passing.

## Catering recovery verified — latest evidence, 7 November 2026

This supersedes earlier entries that describe the historical catering posting as failed or awaiting retry. The user supplied SQL 73 with recovery_verified=true and all six checks true. Journal JV-SCN-2026-000380 (242e406e-c446-4e5a-89fe-918d6203a1a0), dated 2 November 2026, is posted and balanced at KES 4,635: debit Cash on Hand 1000 KES 4,635; credit Events Revenue 4050 KES 3,879.31, VAT Payable 2040 KES 620.69, and Service Charge Payable 2050 KES 135. Receipt attempt 2 is posted with no error. Exactly the original confirmed payment remains, and the order is unchanged. The browser also showed zero blocked and zero failed exceptions for November 1–7. No further retry is needed.

This verifies this historical accounting recovery, not service completion, the wider reconciliation difference, an entire department, or an original complete UAT workflow. The separate KES 5,500 eligible receipt and other historical-period exceptions have not been posted or certified by this recovery.

## Current source batch — printer discovery and revenue reporting

Printer follow-up: 15 agent tests and 27 UI/contract tests passed; TypeScript check, production build and server smoke checks passed. A read-only real local mDNS search detected a Kyocera TASKalfa 4053ci at 192.168.1.245 (IPP and RAW endpoints). No print was sent and thermal compatibility is not established. The DNS-SD service/address resolution source repair and missing-paired-computer guidance are ready locally. A paired running property agent and physical output proof remain outstanding.

SQL 74 supplied by the user confirms the installed reconciliation function sums only the outstanding capped queue, treats pending drafts/open folios as blocked revenue, and compares gross queue values with net ledger credits. New SQL 75 is a guarded reporting-only replacement for Savannah POS and folio calculations: finalized standalone POS net revenue plus posted folio-charge net revenue, retaining posted source records and avoiding duplicate room transfers. Other organisations retain their calculation; other streams are explicitly labelled legacy/unverified. It refuses unconverted foreign-currency POS amounts. No records are posted or corrected by installation. SQL 76 checks installed code and retained helpers. This package is prepared, NOT confirmed applied.

Portable source checks pass: 45 total assertions (the previous 36 accounting checks plus 9 reporting regressions). These are source/isolated-database checks, not 45 original workflows closed. Original UAT classifications remain unchanged. Git push, app deployment and property-agent pairing were not performed in this batch.


## Additive backlog consolidation — 7 November 2026

The new NEO-CONSOLIDATED-BACKLOG-2026-11-07.csv/json and NEO-BACKLOG-CONSOLIDATION-REPORT-2026-11-07.md extend this register with 89 attachment scenarios, nine current-history issues and the eight retained FIN-R requirements. Existing IDs, original UAT statuses and verified recoveries are preserved. These 106 records are not 106 additional original failures. SQL 77 proves the original revenue-report definition remains installed; tested replacement awaits verified installation. See script 78 for combined apply/check. No new hotel transactions were performed for consolidation.



## Reporting installation/live check and fixed execution queue — latest

User postcheck confirms reporting definition matches and all four retained helpers/export are unchanged. The refreshed Nov 1–7 page shows POS source/ledger KES 30,724.40 and Folio source/ledger KES 78,317.25, both zero variance. Other legacy streams remain uncertified; this is not full Finance readiness. No posting/financial action was executed during review.

The fixed 106-item queue is now numbered with permanent IDs and explicit stages: 1 verified done, 105 remaining. The specifically repaired M-PESA queue error is the completed item; full merchant/STK work is separate. R01 is partially verified for POS/folio, and earlier receipt/journal recoveries remain recorded subchecks in broader items. Do not delete/recount tasks to manufacture progress. See NEO-106-EXECUTION-QUEUE-2026-11-07.md/csv/json.



## Queue batch 2 — installed closure and local source fixes



## Final regression result

Regression evidence totals 3,705 passed assertions, zero unresolved failures and 155 skipped tests. All 3,667 previously passed assertion identities from the preceding display-flow baseline remain passed. The initial full run had 3,704 passes and one failure: a receipt source-contract assertion incorrectly counted every branchId binding in the route after PaymentDialog gained its own property. That test now checks the two SendToPrinterButton receipt bindings directly. Its focused five-test suite passed; application source was unchanged between the full run and focused rerun. The evidence JSON records both runs and the merged latest-per-suite result; no second full run is claimed.

Queue baseline remains 106 / 1 verified complete / 105 remaining. Five additional records have moved from queued into deployment/retest or workflow testing. Do not rerun SQL 82 after the confirmed installation.

See QUEUE-BATCH-2-REPAIR-EVIDENCE-2026-11-07.md for the five repair areas, exact tests and remaining live gates. Native property-timezone roster assignment and payment UI fixes are local; Cloudflare app deployment and property-agent pairing were not performed in this batch. No existing schedules, payments, till histories, orders or stock were changed by the agent.


