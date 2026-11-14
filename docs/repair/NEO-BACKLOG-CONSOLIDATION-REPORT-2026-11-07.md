# NEØ backlog consolidation and next checkpoints — 7 November 2026

This is an additive update to the existing repair register. The attachment contributes 89 reported scenarios across 13 departmental groups. Nine additional issues from the current repair history/source review and eight existing FIN-R requirements are linked, producing 106 scenario/requirement records. These are not 106 new failures and must not be added to the original 87.

The structured CSV/JSON includes permanent IDs, department, module, workflow, description, evidence, expected/actual behavior, root-cause confidence, provisional severity, status, classification, dependencies, proposed resolution, acceptance criteria, owner and regression gate. The JSON also preserves all 71 transcribed original workflow records. The original master register and earlier evidence remain intact.

## Existing work reconciled with the attachment

| Existing work | Reconciliation decision |
|---|---|
| Three missing POS receipt links | Verified operational SQL recovery remains closed for those three links. Broader bill/receipt/till/stock scenarios remain separate. |
| Failed historical catering journal | SQL 73 verifies one balanced journal, original payment preserved and order unchanged. Do not retry again or reopen this recovery because the attachment contains an older generic posting failure. |
| Manual delivery Till claim queue | Installation and live queue read verified. The old missing-function error is linked to that repair. Full customer claim → independent merchant approval → payment/invoice/journal still needs proof. STK remains separate. |
| Housekeeping occupancy, laundry linkage/batch delivery, maintenance independent sign-off | Existing source repairs and fixtures retained. New reports become precise deployed regression scenarios; no automatic assertion that those fixes failed. |
| Password reset | Corrected source route/error handling is retained; real sender/inbox and ordinary-role checks remain separate. No replacement authentication/storage architecture is proposed. |
| Printing | Central setup and agent exist; new local discovery fix passes tests and finds a Kyocera. No paired running property agent or physical thermal receipt is certified. |
| Revenue reporting | SQL 74 confirms a defective queue/gross-versus-net calculation. SQL 77 proves the original function is still installed. Tested replacement exists locally; installation remains unverified. |
| Eight FIN-R controls | Existing IDs preserved for inclusive configurable taxes, discounts, KES/USD snapshots, payment instructions/splits, thermal layout, accounting/reversals, print safety and cross-module consistency. |
| Earlier historical development ledger | Source-level DONE statements remain historical evidence. They do not override current operational results or certify full department workflows. |

The observed catering bill was paid while two production items remained in preparation. Keeping that bill open can be the intended service rule. The broader “paid but not Closed” report must distinguish a legitimate service hold from a broken settlement transition; do not bypass service completion merely to make a status green.

## Newly consolidated or sharpened issues

The supplied brief sharpens existing department-level entries into separate scenarios: historical till routing; payment/shift/journal/stock closure; Coffee/Beverage boundaries; configurable station creation; identity/claim/reconnect continuity; recipe/direct-stock/yield distinctions; deposit partial-state consistency; ready-room sellability; guest quote and My Stay linkage; quote persistence and BEO handoffs; return/replacement/variance guards; guest-laundry/batch synchronization; clock/deadline offsets; public zero rates and visible QA menu items.

Additional records NEO-BKL-R01–R09 retain the confirmed reporting defect, missing DNS-SD resolution, install/native distribution, display controls, hidden external dependencies, Mawimbi isolation, historical bar classification review, identity-label disagreement, and email readiness. “Newly consolidated” means newly explicit in this scenario register, not proof the defect was absent from every historical chat.

## Shared architectural dependencies

| Group | Linked problems | Engineering direction and proof |
|---|---|---|
| ARCH-STATIONS | Department/station/category overlap, configurable displays, PIN identity, claims, routing, reconnect and production actions | One configuration-driven station model linked to effective scope and existing ticket lifecycle. Prove a newly configured station end-to-end; preserve the deployed PIN broker and independently attributed staff actions. |
| ARCH-STOCK | Recipes, directly sold stock, yield/batch quantities, duplicate consumption, requisitions, returns and GRN/AP custody | One defined consumption event and source identity, explicit location/unit/recipe mapping, custody and reversal evidence. Test recipe and direct-stock cases with concurrency/retry failures in isolated fixtures. |
| ARCH-SETTLEMENT | Active till, payment/receipt/shift/journal agreement, final closure, deposits, reporting and night audit | Preserve original transaction identities and canonical journal evidence; distinguish service completion, payment, revenue, custody and business-day state. Never fix reports by force-posting draft orders. |
| ARCH-STAY / ARCH-ROOM-STATE | Deposit/folio/stay linkage, occupied stayover, cleaning/inspection, maintenance holds, laundry/minibar and availability | One authoritative occupancy/condition/hold contract; independent sign-offs and catalogue-priced guest charges. Prove guest checkout through inspection to genuinely sellable release. |
| ARCH-PAYMENTS | Manual Till evidence, merchant authority, delivery settlement, STK callbacks and duplicate protection | Keep manual claims and provider STK separate. Verify ownership, independent approval, actual receiving account and durable payment/invoice/journal evidence. |
| ARCH-ACCESS / ARCH-RELEASE | Roles, PINs, branch/department scope, clocks, public identity, installation, integrations and go-live evidence | Preserve current Supabase/Cloudflare architecture; unify scoped settings and timestamp presentation, establish actual release gates and real-device proof. |
| ARCH-PRINT | Agent pairing, discovery, driver/transport support, station routing, offline outcomes and reprints | Updated running property agent plus supported physical device; distinguish discovery, queued job, OS acceptance and paper proof. No extra financial posting on print/reprint. |
| ARCH-EVENTS / ARCH-PUBLIC | Quotes, confirmation/deposit/BEO and tasks; public rates/menu/booking/payment | Persisted versioned business documents and configured publication; complete handoffs and guest linking without deleting operational test/history records. |

These are linked engineering directions, not approved infrastructure migrations or claims that the existing code lacks every listed component.

## Departmental readiness matrix

No department receives a percentage or full independent-operation certificate from this consolidation.

| Department | Verified or existing evidence | Outstanding defects / untested gates / current work | Independence condition |
|---|---|---|---|
| Restaurant/waiter | Orders and service views load; historical catering recovery verified | Historical till routing, ordinary waiter attribution, routing/service/closure and stock synchronization | One complete normally serviced order with all downstream evidence |
| Kitchen/bar/coffee/pastry | Queue loads; source routing/guard evidence exists | New station configuration, PIN claim, categories/subdivisions, reconnect, recipe/beer/coffee/pastry movements | Independent staff actions at every configured station, correct tickets and once-only stock |
| Cashier/till | Catering confirmed cash payment and one recovered journal | Correct active till/shift, split tenders, discount authority, cash variance and end-of-shift | Cash collections, receipt, shift balance, stock and ledger agree |
| Front Office/reservations | Original visible availability/new reservation/deposit/assignment/check-in passes preserved; views load | Deposit partial status, quote breakdown, guest linking, stayover, folio/checkout/availability | One full stay through settlement and safe room release |
| Housekeeping | Original visible green neighbors protected; occupancy/checklist source repairs | Independent acceptance/inspection/rework and FO synchronization; source regressions pending | Occupied rooms protected and inspected eligible room actually sellable |
| Procurement/stores | Views and GRN source evidence | Return/replacement guards, requisition custody, count variance, PO/GRN/invoice/AP matching and approvals | One controlled request-to-receipt-to-payable chain plus exception/reversal |
| Events/banqueting | Event surfaces exist | Quote persistence, prerequisites, department/assignee tasks, BEO, stores and final settlement | Complete enquiry-to-closure lifecycle with accountable handoffs |
| Laundry/minibar | Laundry/folio pricing/idempotency and delivery source repairs | Guest order/batch synchronization, delivery charge and minibar regression | Correct production/delivery status and one stock/folio/journal effect |
| Engineering/maintenance | Independent verification/handback source repairs | Ordinary technician/supervisor sequencing, asset/parts/history and room holds | Completed work independently checked before safe handback |
| Delivery/guest payments | Manual Till functions installed; live queue reads | Customer/merchant workflow, dispatch/rider completion, separate STK and callback/reconciliation | Correct authorised end-to-end delivery and once-only settlement |
| Finance/accounting | Three receipt links and catering journal verified; November exceptions cleared | Reporting replacement installation mismatch, broader reconciliations, deposits, tax/FX, reversals and other periods | Earned source facts, receipts, tenders and ledger reconcile without fabricated closure |
| Night audit | Older audit exception record and disabled closure observed | Business-date recovery, outstanding bill/session controls, day close and next-day opening | Authorised normal shift/day transition with no forced balances |
| Administration/configuration | Entry chooser live; devices page accessible; source controls exist | PIN/role coverage, duplicate departments, clock offsets, intermittent staff dashboard, integration/release evidence | Intended ordinary roles can do required duties and are denied unrelated duties |
| Guest booking/services | Public/guest surfaces exist | Zero nightly rate, QA menu publication, quote breakdown, booking hold/confirmation/payment/My Stay proof | Coherent published inventory and one complete guest journey |
| Management/owner reporting | Owner dashboard loads | Earned-revenue calculation mismatch, catalogue readiness gaps and reliable audit/oversight | Trusted source-to-report totals and populated evidence-backed launch gates |

## Development priority and two workstreams

1. **Current engineering lane:** reconcile reporting installation using exact definitions; finish source/deployed parity. Preserve the verified financial recoveries and original passes.
2. **Launch-blocking foundations:** active-till/shift identity, station/PIN/role configuration, authoritative room-state handoffs and once-only stock/settlement boundaries. Reproduce each reported current failure before changing a working guard.
3. **Complete core workflows:** a four-station sale, one guest stay/turnover, laundry/minibar, maintenance verification and stock/GRN/AP chain. Resolve missing links in dependency order.
4. **Physical operations and daily controls:** paired agent/physical receipts, cashier shift close, business-date recovery and night audit. No bulk financial backfill as a workaround.
5. **Guest/events/delivery release gates:** public rates/menu cleanup through reviewed publication, event handoffs, customer merchant claims, separate STK, real-device/native releases and populated go-live evidence. These remain in scope; the initial-release exclusion decision has not been made for them.

New historical reports do not automatically supersede active repairs. Severity is provisional impact triage: potential financial/security/stock integrity exposure is P0, essential independent operation P1, important configuration/UI weakness P2, and enhancements P3. Current corruption must not be inferred solely from a P0 label.

Workstream A continues source fixes and isolated failure/retry tests. Workstream B resumes normal operational UAT from the latest verified checkpoint, records new findings immediately and retests affected outcomes after deployment. Because the configured database contains real operations, the attachment's general synthetic-test language is not blanket authorisation for new bookings/payments/stock writes. Mawimbi remains read-only. Use isolated fixtures until a specific safe operational test boundary is established.

## Next UAT checkpoint

Do not rerun the recovered catering payment/journal. After reporting code parity is established, inspect the existing paid catering order's production/ticket and staff identity history read-only. Its last observed items were still preparing. Establish whether ordinary station staff can complete the normal service lifecycle and whether the intended cashier/till owns the existing payment. A full four-station sale then requires a labelled, authorised test boundary, assigned staff/stations, configured recipes and a supported printer. Do not synthetically serve real food, close a shift or deduct stock to obtain a pass.

In parallel, use read-only configuration/role inventory and isolated fixtures for station creation/routing/PIN scope, occupied-room protection and recipe/direct-stock idempotency. The next physical printing checkpoint is pairing/running the agent and a labelled test on a compatible device; detected Kyocera endpoints alone do not certify thermal compatibility.

## Coverage and uncertainty

- The board reports 87 fail / 28 partial / 30 pass; an earlier brief says 88 fail. Only 71 complete tiles are available: 33 fail / 15 partial / 23 pass. The 54 other failed identities and seven pass identities remain unavailable. No totals are guessed.
- This consolidation reviewed the supplied attachment, current chat evidence, original visible baseline/tracker, current readiness and fresh-cloud review, master FIN-R register, source evidence ledger and historical development ledger. Other historical chats and any external complete UAT workbook were not newly exhaustively retrieved; their availability is an evidence gap.
- No fresh end-to-end transactional UAT or new production source audit was performed merely to classify the attachment. Reported issues are not automatically confirmed defects, and screens/source tests are not full operational proof.
- The source-ledger's historical DONE claims are not reopened or promoted without current evidence. Fixture context, mocked integrations and live observations are explicitly separate.
- Owners are not yet individually assigned. The register records Unassigned rather than inventing accountable department staff.
- Other revenue streams, FX conversion, physical paper, native signing/store accounts, independent roles and full provider callbacks remain outside the verified POS/folio/queue subchecks.

The new CSV/JSON and scenario index are the additive queue companion. The earlier 71-row workflow tracker continues to hold original UAT results; scenario IDs and test assertions are never counted as original workflow closures.
