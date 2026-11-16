# Procurement, documents and PMS acceptance inventory

Reviewed 16 November 2026 against the current local working tree. This is a local acceptance baseline, not a production sign-off. Existing uncommitted finance/PMS work was preserved. No live purchase, stock movement, booking, payment, communication or deployment was performed.

Subsequent repair work and current results are tracked in `ACTIVE-EXECUTION-QUEUE.md`. That record supersedes this baseline's description of Print as download-only and of the folio's agent action. It also records the rebuilt Windows discovery agent, staged minibar/store and purchase-approval guards, and the remaining live acceptance gaps.

## Procurement, suppliers, stores and inventory

| Requirement | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Requisition, quotation, approval and LPO | Stores/procurement fixture contracts and supply-chain suites cover transitions, approval authority and retry keys | Execute the connected chain as actual staff against installed definitions |
| Supplier communication | RFQ page reads provider connections and explicitly records dispatch manually | Prove actual outbound delivery and durable provider/message references; manual dispatch status alone is insufficient |
| Blind count, reconciliation and acceptance | Executable isolated PostgreSQL tests exercise review wrapper and receiving engine; approval without posting authority exposes a separate approved-GRN handoff | Verify the installed version and both operator roles in the browser |
| Accepted/rejected quantities, batches, expiry and GRN | Receiving engine and result checks pass locally; posted GRNs remain separate from blind count documents | Reconcile physical delivered, accepted, rejected and short quantities to batch balances and original PO across partial deliveries |
| Three-way match and payable | Local supplier quantity-parity migration exists at `20261115020000_supplier_matching_quantity_parity.sql` | Execute approved LPO to accepted GRN to invoice to posted payable, including duplicate and cross-property refusals |
| Main store to department stores | Store routing and station selection tests pass | Confirm actual department mappings, transfer receipt, returns and Bar/Minibar property boundaries with real records |
| Recipes, costs and waste | Recipe engine and supply-chain contracts provide local coverage | Recipe consumption suite has skipped coverage; do not certify stock deduction, waste or returns solely from these contracts |

Gate remains open: only accepted stock may post, and each payable must trace through its supplier invoice and GRN to the original approved purchase.

## Required document inventory

The canonical server export path is `DocumentPrintButton` -> `exportBusinessDocument` -> `document-pdf.server.ts` -> `neo_document_payload`. The export API declares **11 types**. Shared preview/template comments describe additional use cases and are not proof of implemented generators.

| Required document | Generator/source identified | Acceptance state |
| --- | --- | --- |
| Customer receipt | `pos_receipt`, canonical POS payload; POS order screen | Source contracts pass; actual download, reprint and physical output unverified here |
| Customer invoice / event bill | `invoice`, canonical invoice payload; receivables and event invoice hooks | Source contracts pass, including reuse of issued event invoice; live status-change retrieval unverified |
| Statement / folio | `folio_statement`, canonical folio payload; folio screen | Property isolation tests pass; account statement requirements beyond a folio remain to inventory |
| Booking confirmation | No dedicated canonical export type | Identify owning confirmation output, source, saved number and retrieval path |
| Supplier RFQ | RFQ records and manual dispatch UI; no dedicated canonical export type | Generator, PDF and communication acceptance remain open |
| LPO | `purchase_order`, canonical PO payload; LPO detail screen | Source wiring and historical trail checks pass |
| Supplier delivery note | Receiving stores delivery-note reference | A reference is not an archived supplier document; attachment and retrieval acceptance remain open |
| GRN | `goods_receipt`, canonical receipt payload; LPO and posted-receiving surfaces | Source contracts distinguish posted GRN from blind count; live print/download unverified |
| Remittance advice | No dedicated canonical export type | Identify supplier payment source, generator and durable history; rider cash remittance is a different workflow |
| Event quotation | No dedicated canonical export type | Verify quotation-specific generator and approved version retrieval |
| Event contract | No dedicated canonical export type | Verify generation or signed attachment, version and transaction linkage |
| BEO | `beo`, canonical booking payload; event booking screen | Source wiring covered; actual preview, download and reprint remain open |
| Event confirmation | No dedicated canonical export type | Identify confirmation source and durable issued output |
| HR letters / employment contract | `hr-documents.ts` stores employee files with supersession chains | Upload/version storage does not establish letter or contract generation |
| Staff records | Employee document storage; `staff_schedule` is a separate supported export | Verify required staff-record format and scoped retrieval |
| Payslip | `payslip` export; salary slip preview also exists | Reconcile both outputs to the applicable payroll record and access rules |
| Inventory requisition | `requisition`, canonical requisition payload | Source wiring covered |
| Stock count sheet | `stock_sheet`, canonical stock payload | End-to-end output remains open |
| Task sheet | `task_sheet`, canonical task payload | End-to-end output remains open |

For every row, retain transaction ID, organization/property, issued number, date/timezone, currency, source status, actor, preview/download result, physical printer result and reprint identity. Repeat retrieval after status changes; rendering must not issue a second transaction. No physical print or newly generated PDF was inspected in this audit. Prior synthetic layout verification is documented separately in `DOCUMENT-LAYOUT-2026-11-15.md`.

## Front Office, PMS, housekeeping and laundry

| Requirement | Local evidence | Remaining acceptance |
| --- | --- | --- |
| Actual check-in, stay, folio and room | Check-in lifecycle contracts and isolated future-date PostgreSQL guard tests | Full real staff arrival with assigned room and installed routine evidence |
| Deposit and first-night charge | PMS money parity tests exercise isolated SQL collaborators | Reconcile original deposit, folio application and first accommodation posting without double counting |
| Night audit, tax/service and retries | Folio component contracts cover amount semantics | Consecutive business-day execution, retries, exemptions and exact posted journals |
| Corporate/group multi-folio settlement | Local canonical checkout migration explicitly requires exactly one folio; regression confirms refusal | Still restricted. Implement reconciled multi-folio settlement before closing this task |
| Adjustments, refunds, minibar and room service | Folio action/component coverage and checkout money checks | Real source-to-folio-to-finance reconciliation for every charge and reversal |
| Checkout and housekeeping | Isolated checkout execution and housekeeping chain contracts | Actual checkout -> vacant dirty -> cleaning/inspection -> sellable, including failed-payment refusal |
| Guest laundry | 23 isolated PostgreSQL checks passed | Actual laundry handoff, bill, return and historical retrieval with operator roles |

Gate remains open: a real booking must complete arrival through departure with exact money, journal and room-state reconciliation. Isolated tests, mocked SQL collaborators and source assertions do not establish that gate.

## Verification run

Initial focused run: **13 files, 145 tests passed**. Includes blind receiving result/review/virtual-location guards, stores procurement contracts, store/station routing, business documents, document identity/property isolation, PMS money parity, checkout execution, future check-in and guest laundry.

Extended run: **12 files, 202 passed, 6 skipped**. Includes supply-chain closure/certification/master data/durable mutations, check-in lifecycle, housekeeping execution, folio settlement actions/components, recipe engine/consumption contracts and physical-print-agent contracts/PostgreSQL API. Combined: **25 files, 347 passed, 6 skipped**. Print API tests do not establish physical printer output.

Tests were run through the installed Vitest entry point because the host NVM trust shim blocked `npx`. Loading the Vite configuration required filesystem escalation. No toolchain trust settings were changed.
