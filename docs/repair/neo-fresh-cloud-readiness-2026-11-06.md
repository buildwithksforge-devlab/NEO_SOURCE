# NEØ current departmental readiness — fresh cloud-browser review

6 November 2026 · Africa/Nairobi · Savanna Crown Nairobi

## Current position

The latest source is committed/pushed as 7ce7375 (Add verified M-PESA repair and fix payment and entrance UI). The fresh cloud browser served source fingerprint f9fe3068b2bc497c. The current local source and built server independently match that fingerprint. This confirms the latest reviewed source is live; it does not certify every business workflow.

The fresh session was opened visibly and left at the standalone work chooser. It resolved the existing authorised Nairobi work context without asking for another sign-in. Review was read-only: no bookings/orders/claims, payment approvals, posting retries/backfills, business-day actions, messages, device activation/revocation, printer pairing/tests, settings saves or stock/room changes were performed.

Several foundation and screen-level repairs are now verified live. The system is not yet certified for independent full-day hotel operation. Remaining work centres on complete financial, inventory, guest-stay and staff handoffs. Existing old or synthetic records are not automatically software failures, and no records were cleaned up for this review.

## What is now verified

- The JSON-quoted work-entry URL opens the chooser outside the OS dashboard frame. Enter NEØ System transitions to the workspace without the previous frame/conditional-hook issue observed in earlier work.
- The authenticated Owner dashboard loads its recorded operational and financial fact services. Navigation exposes Front Office, F&B/Bar, Delivery, Operations, Supply Chain, Commercial/Finance, CRM, Analytics, Management, Administration and Readiness.
- The M-PESA claims SQL was user-installed and all installation postchecks passed. The fresh Payment Register loads its verification panel and valid empty-queue message, with no missing-function error. This proves the current Owner read/queue path, not a payment approval or STK callback.
- Rooms, housekeeping, kitchen tickets, POS orders, laundry, maintenance, events, procurement, configuration, device/PIN administration, finance posting, night audit and readiness views opened. A page opening or showing an action does not prove its write, permission denial or downstream accounting works.
- Printer setup is visibly under Configuration Centre → Integrations → Printers & Print Queue. The local-agent prerequisites are represented rather than claiming a saved connection name equals a working printer.

## Department and individual readiness

| Area / people | Fresh observation | Still needed for independent use |
|---|---|---|
| Restaurant POS / waiter, cashier | Orders & Bills loads multiple service channels and persisted lifecycle states. Kitchen queue shows routed tickets at multiple stations and zero missing station assignments in its displayed live count. | One four-station sale through employee attribution, exact recipe/stock deductions, permitted discount/tender, active till, receipt, balanced journal and closed bill. Physical tickets/receipts remain unproved. |
| Production / chef, bartender, barista, pastry | Live queue shows New, Accepted, Preparing and Ready work with employee actions available. | Each station employee's own PIN, legal claim/transitions, ordinary-role denial, reconnect/handover and all recipes/conversions. No tickets were moved in this review. |
| Front Office / receptionist, reservations, guest | Rooms & room types loads 46 rooms and six room types, showing occupancy, sellability and exclusion reasons. | Reservation/deposit agreement across folio, one charge, settlement/checkout and eligible room release. Guest booking was not recreated in this fresh review; prior confirmation-screen evidence is historical. |
| Housekeeping / attendant, supervisor | Room Board loads cleaning, inspection and occupancy states, plus task links. A clean room is not automatically sellable; the room view can give an inactive-inventory reason. | Actual independent task acceptance/completion/inspection and Front Office sync after checkout; occupied stayover protection. Current room labels alone do not prove lifecycle transitions. |
| Laundry / attendant, Front Office | Guest laundry view opens with intake, processing, delivery and unposted-charge surfaces. | Ordinary-role collection, batch reconciliation, handover and exactly one folio/journal charge. Previously prepared SQL must have its own application/postcheck evidence; claim SQL installation says nothing about laundry SQL. |
| Maintenance / technician, supervisor | Work-order list loads and completed jobs expose Send for checking rather than treating repair progress alone as verified closure. | Independent supervisor evidence, actual closure refusal before verification, material/room holds and authorised room handback. No repair statuses or blocks were changed. |
| Stores/procurement / requester, approver, receiver, storekeeper | Procurement and receiving/reconciliation surfaces open. | Replacement guard; request/approve/issue/return/transfer/count; correct GRN result and stock custody; supplier invoice/AP matching. Page availability is not inventory/finance proof. |
| Events / coordinator, banquet lead, department heads | Events Dashboard exposes enquiry, quote, booking, department-readiness, banquet and money-handoff areas. | Persistent quote lines, approval/confirmation prerequisites, departmental task generation, deposit, stores handoff and final settlement. No event was confirmed or altered. |
| Delivery / dispatcher, rider, guest, cashier | Manual M-PESA Till verification queue now reads successfully. | Guest claim and independent merchant approval to payment/invoice/journal, complete rider dispatch/delivery/shift, and separate provider-sandbox STK initiation/callback/idempotency if required. |
| Finance / accountant, cashier, night auditor | Posting exceptions and persistent night-audit evidence are visible. Specific failed and blocked reasons are exposed. | Resolve the causes without blindly replaying historic money; prove settlement/till/ledger agreement, shift close, coherent business-date recovery, day close and next-day open. |
| Administration / owner, system admin, ordinary staff | Configuration Centre and Device Authorisation/Staff PINs open. Authorised devices are listed; many listed employees show No active personal PIN. No PIN values are exposed. | Verify/setup the intended individuals and their permitted duties, preserve the working broker, and prove denied access with ordinary accounts. No credentials, PINs or grants were changed. |
| Printing and downloads / property operator, IT | Central printer discovery UI is live; it reports no paired property computer. Browser Install app control is present. | Pair/run the owned local agent after appropriate backend parity checks; resolve legacy browser-only profiles; prove physical paper/reprint/failover. Real-device install/update/offline/private-session behavior and native/store signing/distribution remain unverified. |

## Concrete remaining blockers observed

1. **Financial posting evidence:** the monthly posting exception register shows six blocked entries and one failed entry. Blocked entries report no balanced posted journal / an unbacked posting receipt. Some references appear twice under related reasons, so six entries must not be described as six unique transactions. The failed POS entry reports Unmapped Savannah revenue category: event-catering. These are direct repair targets.
2. **Scope matters:** the Owner dashboard uses Last 30 days and reports 18 blocked / one failed; the posting screen uses This month (1–6 November) and reports six blocked / one failed. These numbers are not a verified contradiction because their date ranges differ. Open/pending records awaiting normal workflow completion are not automatically posting defects.
3. **Business-day recovery:** after loading, Night Audit selected the older 25 September 2026 business date and its persisted exception run, with 18 blockers and Close disabled. This is not a newly executed November audit. Outstanding bills and an open cashier session are listed. It must be investigated and recovered deliberately; no forced close or historical balance rewrite was attempted.
4. **Physical printing:** no property computer is paired in the current printer view, and legacy browser connection profiles remain visible. A queued or historically Completed row is not proof of paper at the right device.
5. **Release evidence:** Go-Live Readiness shows no checklist/gates (0/0 and Not ready). Integration Centre records no verified connections/tests/webhooks in the viewed workspace. Zero listed defects in an unpopulated readiness system is not evidence of zero defects. These screens alone do not establish whether every server secret/provider outside their catalogue exists.
6. **Email readiness:** Configuration Centre reports no enabled provider connection/verified sender recorded and explains default-sender fallback. The reset route source fix does not prove inbox delivery. No verification email or external message was requested.

Secondary review item: the public landing greeting and staff workspace showed different display names. Check the public/guest versus staff identity mapping/labels before classifying this as either intended portal identity or a defect; this review does not establish cross-account data leakage.

## Remaining wave exits

| Existing wave | Current progress | Exit still open |
|---|---|---|
| 1 — safe state and trustworthy writes | Source repairs prepared/tested; live entry and current claim queue are verified. | Exact deployed parity/postchecks for other SQL bundles, room-state reproduction, role isolation, financial posting integrity and original 30 regressions. |
| 2 — complete one guest stay | Front Office/HK views load; laundry/maintenance source repairs exist. | Complete deposit-to-checkout-to-room-release chain, including folio, laundry/minibar/room-service, independent verification and one journal per charge. |
| 3 — four-station sale | POS/production views and central printing configuration are live. | One correctly attributed and stocked sale, complete settlement/close and physical receipt/tickets. |
| 4 — stock/AP/day controls | Procurement, posting and audit surfaces load; actual exceptions are visible. | Full stock custody/AP chain, cashier shift and business-day recovery/close, provider reconciliation. |
| Additional events/delivery/Mawimbi/printer scope | Device/PIN administration and repaired manual Till queue are visible. | Complete event/rider/merchant handoffs, separate STK evidence, physical station proof and Mawimbi read-only isolation. |

No whole wave is certified exited by this review. The cropped board (87 failed, 28 partial, 30 passed) and earlier 88-failure brief remain different evidence. Only 71 complete board tiles were transcribed; the full original register and all 30 pass identities are still unavailable. Do not invent a percentage or count this read-only screen review as closure of transactional red workflows.

## Five next actions, in priority order

1. Trace and repair the missing/unbalanced journal links and event-catering revenue mapping, preserving existing payment/receipt IDs and avoiding blind retries/backfill. Prove one restaurant sale reconciles and closes under the intended cashier/till.
2. Prove one complete guest stay: transparent quote, deposit, check-in, charges, settlement, checkout and eligible housekeeping-to-sellable release, with occupied-stayover protection.
3. Recover the older business date through the documented finance process; then demonstrate an entire controlled operating day, shift close, night audit, day close and next-day open. Do not force balances or close the day through exceptions.
4. Finish individual-role/department handoffs and local printing: personal staff/PIN attribution, recipe/stock coverage, laundry, independent maintenance, procurement/AP and events. Pair the owned local print agent and confirm physical output.
5. Establish the mandatory release checklist with evidence references, rerun the original 30 alongside repaired flows, and prove required provider callbacks/STK separately. Test transactions require an explicitly approved isolated boundary; the existing operational database is not a blanket synthetic-data sandbox.

## Evidence sources reviewed

- Workspace and chooser: https://neo-preview.neo-hospitality.workers.dev/workspace and /workspace?home=%221%22
- Posting: https://neo-preview.neo-hospitality.workers.dev/finance/posting
- M-PESA panel: https://neo-preview.neo-hospitality.workers.dev/finance/payments
- Night audit: https://neo-preview.neo-hospitality.workers.dev/finance/eod
- Rooms: https://neo-preview.neo-hospitality.workers.dev/pms/rooms
- Housekeeping: https://neo-preview.neo-hospitality.workers.dev/housekeeping/board
- Production: https://neo-preview.neo-hospitality.workers.dev/kitchen/queue
- POS: https://neo-preview.neo-hospitality.workers.dev/pos/orders
- Laundry / maintenance / events / procurement: /laundry, /maintenance, /events, /procurement on the same host
- Configuration / printing / devices: /settings, /admin/printers, /device-authorisation
- Release / integrations: /platform, /platform/integrations

Prior source evidence remains distinct: 3,667 full offline passes / 155 skips at the preceding display gate; 32 isolated claim SQL checks; 45 focused payment/entry UI checks plus typecheck and build/smoke on the latest follow-up. None were rerun merely to produce this read-only review. Physical printing, real-device/native distribution and full live transactional outcomes remain separate evidence gates.
