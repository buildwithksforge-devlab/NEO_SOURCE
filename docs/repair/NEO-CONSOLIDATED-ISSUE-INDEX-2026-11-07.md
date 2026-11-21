> Historical snapshot. Current queue and validation: [8 November readiness](NEO-CURRENT-READINESS-2026-11-08.md).

# Consolidated scenario index — 7 November 2026

Additive companion to the existing master register. Permanent original UAT IDs and FIN-R IDs are preserved. New scenario IDs do not represent new original-UAT failures. Full fields, dependencies and acceptance criteria are in the CSV/JSON. Reported historical issues require present-revision verification; P0 is provisional integrity-impact triage.

| ID | Department | Severity | Current status | Scenario |
|---|---|---|---|---|
| NEO-BKL-A01 | Restaurant / Cashier | P0 | Reported issue — current reproduction pending | Receipts routing to historical or incorrect tills. |
| NEO-BKL-A02 | Restaurant / Cashier | P1 | Reported issue — current reproduction pending | Paid restaurant bills failing to reach final Closed status. |
| NEO-BKL-A03 | Restaurant / Cashier | P1 | Reported issue — current reproduction pending | Payment recorded without complete transaction closure. |
| NEO-BKL-A04 | Restaurant / Cashier | P0 | Reported issue — current reproduction pending | Payment, receipt, cashier shift, and accounting journal inconsistencies. |
| NEO-BKL-A05 | Restaurant / Cashier | P0 | Three metadata links and catering journal recovered; wider scenario awaits regression | POS journals generated but blocked from final posting. |
| NEO-BKL-A06 | Restaurant / Cashier | P0 | Reported issue — current reproduction pending | Potential inconsistencies in bill closure versus inventory deductions. |
| NEO-BKL-A07 | Restaurant / Cashier | P0 | Open verification gate | Unverified reconciliation of cashier collections against active shift balances. |
| NEO-BKL-A08 | Restaurant / Cashier | P1 | Open verification gate | Incomplete evidence of the entire order-to-settlement lifecycle. |
| NEO-BKL-B01 | Production | P0 | Reported issue — current reproduction pending | Coffee and Beverage configurations appear to overlap or duplicate station responsibilities. |
| NEO-BKL-B02 | Production | P1 | Reported issue — current reproduction pending | Some beverage operations are not behaving consistently with kitchen subdivisions such as Grill and Larder. |
| NEO-BKL-B03 | Production | P1 | Reported issue — current reproduction pending | Existing routing may not reliably distinguish departments, production stations, and item categories. |
| NEO-BKL-B04 | Production | P1 | Reported issue — current reproduction pending | Station types may be hardcoded instead of fully configuration-driven. |
| NEO-BKL-B05 | Production | P1 | Reported issue — current reproduction pending | Adding new production display stations may not automatically integrate into routing, authentication, and workflow management. |
| NEO-BKL-B06 | Production | P1 | Open verification gate | Staff PIN entry, acceptance, and identity attribution are incomplete or require verification. |
| NEO-BKL-B07 | Production | P1 | Open verification gate | Paired display authentication and station claiming remain unproven. |
| NEO-BKL-B08 | Production | P1 | Open verification gate | Shift continuity, session persistence, reconnect behavior, and role permissions require verification. |
| NEO-BKL-B09 | Production | P0 | Reported issue — current reproduction pending | Coffee ingredient mappings and beer inventory deductions have failed in previous testing. |
| NEO-BKL-B10 | Production | P0 | Reported issue — current reproduction pending | Pastry stock deduction and cross-station production reconciliation remain incompletely verified. |
| NEO-BKL-C01 | Inventory | P1 | Reported issue — current reproduction pending | Incorrect or incomplete ingredient deductions. |
| NEO-BKL-C02 | Inventory | P0 | Reported issue — current reproduction pending | Coffee recipes and ingredient mapping inconsistencies. |
| NEO-BKL-C03 | Inventory | P0 | Reported issue — current reproduction pending | Beer and beverage stock movements failing in some scenarios. |
| NEO-BKL-C04 | Inventory | P1 | Open verification gate | Pastry consumption not fully proved. |
| NEO-BKL-C05 | Inventory | P0 | Reported issue — current reproduction pending | Risk of duplicate stock deductions across service, payment, and bill closure. |
| NEO-BKL-C06 | Inventory | P1 | Open verification gate | Need to distinguish recipe consumption from directly sold inventory. |
| NEO-BKL-C07 | Inventory | P1 | Reported issue — current reproduction pending | Incomplete validation of portion yields, recipe quantities, and batch recipes. |
| NEO-BKL-C08 | Inventory | P1 | Reported issue — current reproduction pending | Requisition issues, returns, replacements, and stock variance controls remain incomplete. |
| NEO-BKL-C09 | Inventory | P0 | Open verification gate | Stock movement reconciliation against actual sales needs validation. |
| NEO-BKL-D01 | Front Office | P0 | Reported issue — current reproduction pending | Reservation deposits incorrectly marking full balances as Paid instead of Partial. |
| NEO-BKL-D02 | Front Office | P0 | Reported issue — current reproduction pending | Outstanding balances not consistently displayed. |
| NEO-BKL-D03 | Front Office | P0 | Reported issue — current reproduction pending | Disagreement between reservation balances, payment records, and guest folios. |
| NEO-BKL-D04 | Front Office | P1 | Source repair exists; affected live scenario awaits regression | Stayover room occupancy behavior remaining incorrect. |
| NEO-BKL-D05 | Front Office | P1 | Reported issue — current reproduction pending | Room availability sometimes failing to update despite Ready status. |
| NEO-BKL-D06 | Front Office | P1 | Reported issue — current reproduction pending | Guest booking quote showing KES 7,500 room price and KES 8,700 total without a clearly explained breakdown on the observed confirmation screen. |
| NEO-BKL-D07 | Front Office | P1 | Open verification gate | Complete guest booking confirmation and inventory hold remain unverified. |
| NEO-BKL-D08 | Front Office | P1 | Open verification gate | Guest My Stay linking and payment visibility remain insufficiently verified. |
| NEO-BKL-D09 | Front Office | P1 | Open verification gate | Checkout settlement and subsequent room release require end-to-end verification. |
| NEO-BKL-E01 | Housekeeping | P1 | Reported issue — current reproduction pending | Room marked Clean/Ready but remaining unavailable in Front Office in a later test. |
| NEO-BKL-E02 | Housekeeping | P1 | Open verification gate | Independent attendant acceptance and attribution not fully verified. |
| NEO-BKL-E03 | Housekeeping | P1 | Reported issue — current reproduction pending | Incomplete proof of status synchronization across checkout, cleaning, inspection, and availability. |
| NEO-BKL-E04 | Housekeeping | P1 | Source repair exists; affected live scenario awaits regression | Need to prevent rooms from becoming sellable before required inspections are complete. |
| NEO-BKL-F01 | Events | P1 | Reported issue — current reproduction pending | Quotation lines failing to persist. |
| NEO-BKL-F02 | Events | P1 | Reported issue — current reproduction pending | Quotation actions previously missing or incomplete. |
| NEO-BKL-F03 | Events | P1 | Reported issue — current reproduction pending | Event confirmation bypassing necessary prerequisites. |
| NEO-BKL-F04 | Events | P1 | Reported issue — current reproduction pending | Automatically generated tasks lacking department assignments. |
| NEO-BKL-F05 | Events | P1 | Reported issue — current reproduction pending | Departmental handoffs incomplete. |
| NEO-BKL-F06 | Events | P1 | Open verification gate | Event stores requisitions and stock issue not fully demonstrated. |
| NEO-BKL-F07 | Events | P1 | Reported issue — current reproduction pending | Event deposits, BEO publication, operational execution, final invoice, and settlement not verified as one complete lifecycle. |
| NEO-BKL-G01 | Procurement / Stores | P1 | Reported issue — current reproduction pending | Replacement/return guard failures. |
| NEO-BKL-G02 | Procurement / Stores | P1 | Open verification gate | Need to validate requisition-to-issue operations. |
| NEO-BKL-G03 | Procurement / Stores | P1 | Reported issue — current reproduction pending | Incomplete stock return and stock count variance workflows. |
| NEO-BKL-G04 | Procurement / Stores | P1 | Reported issue — current reproduction pending | Incomplete supplier invoice-to-GRN matching. |
| NEO-BKL-G05 | Procurement / Stores | P1 | Open verification gate | Need to verify purchasing permissions and independent approvals. |
| NEO-BKL-G06 | Procurement / Stores | P1 | Reported issue — current reproduction pending | Ensure purchase orders, blind receiving, GRNs, stock entries, and supplier liabilities remain properly linked. |
| NEO-BKL-H01 | Laundry / Minibar | P1 | Reported issue — current reproduction pending | Laundry production batch completed, but guest order remaining Collected. |
| NEO-BKL-H02 | Laundry / Minibar | P1 | Reported issue — current reproduction pending | Laundry delivery and folio posting incomplete. |
| NEO-BKL-H03 | Laundry / Minibar | P1 | Reported issue — current reproduction pending | Guest order and processing batch statuses not synchronized. |
| NEO-BKL-H04 | Laundry / Minibar | P1 | Open verification gate | Minibar transaction requires regression testing after a subsequent blocked run. |
| NEO-BKL-H05 | Laundry / Minibar | P0 | Reported issue — current reproduction pending | Ensure direct stock movement, folio charging, and journal posting occur only once. |
| NEO-BKL-I01 | Engineering | P1 | Source repair exists; affected live scenario awaits regression | Managers able to close maintenance work orders before completion or independent verification. |
| NEO-BKL-I02 | Engineering | P1 | Source repair exists; affected live scenario awaits regression | Technician completion and supervisor sign-off require enforced sequencing. |
| NEO-BKL-I03 | Engineering | P1 | Reported issue — current reproduction pending | Maintenance history, asset records, and operational status need consistency. |
| NEO-BKL-J01 | Finance / Night audit | P1 | November observed exceptions cleared; other periods and full finance still open | Blocked and failed financial postings. |
| NEO-BKL-J02 | Finance / Night audit | P0 | Reported issue — current reproduction pending | Payment and till reconciliation gaps. |
| NEO-BKL-J03 | Finance / Night audit | P0 | Reported issue — current reproduction pending | Deposit-to-folio reconciliation failures. |
| NEO-BKL-J04 | Finance / Night audit | P1 | Reported issue — current reproduction pending | Incomplete end-of-shift settlement. |
| NEO-BKL-J05 | Finance / Night audit | P0 | Reported issue — current reproduction pending | Potential journal duplication and inconsistent posting status. |
| NEO-BKL-J06 | Finance / Night audit | P1 | Open verification gate | Incomplete evidence for business-day closure. |
| NEO-BKL-J07 | Finance / Night audit | P1 | Open verification gate | Night audit end-of-day closing and next-day opening unverified. |
| NEO-BKL-K01 | Delivery / Payments | P1 | Specific missing-function defect repaired and verified; preserve regression gate | Delivery M-PESA Till verification error referencing `public.neo_delivery_mpesa_till_claim_queue`. |
| NEO-BKL-K02 | Delivery / Payments | P1 | Reported issue — current reproduction pending | Database/API schema mismatch or missing database object requires investigation. |
| NEO-BKL-K03 | Delivery / Payments | P1 | Open verification gate | Delivery dispatch and rider completion not fully demonstrated. |
| NEO-BKL-K04 | Delivery / Payments | P1 | Open verification gate | M-PESA STK Push initiation, callback, and settlement unverified. |
| NEO-BKL-K05 | Delivery / Payments | P0 | Open verification gate | Payment reconciliation and duplicate callback protection need validation. |
| NEO-BKL-L01 | Administration | P1 | Source repair exists; affected live scenario awaits regression | Password reset previously returning Invalid API key. |
| NEO-BKL-L02 | Administration | P0 | Reported issue — current reproduction pending | Duplicate Main Kitchen department choices. |
| NEO-BKL-L03 | Administration | P2 | Reported issue — current reproduction pending | Shift schedule displayed three hours differently from configured time. |
| NEO-BKL-L04 | Administration | P2 | Reported issue — current reproduction pending | Production deadlines showing similar time offsets. |
| NEO-BKL-L05 | Administration | P1 | Reported issue — current reproduction pending | Tasks created without department or assignee. |
| NEO-BKL-L06 | Administration | P1 | Reported issue — current reproduction pending | Missing or incomplete station PIN configurations. |
| NEO-BKL-L07 | Administration | P1 | Reported issue — current reproduction pending | Incomplete employee-level role and permission validation. |
| NEO-BKL-L08 | Administration | P1 | Discovery source repaired/tested; pairing and paper proof open | Physical receipt and production printing remain unverified. |
| NEO-BKL-L09 | Administration | P1 | Reported issue — current reproduction pending | Staff dashboard intermittently failing to load. |
| NEO-BKL-L10 | Administration | P2 | Reported issue — current reproduction pending | Integration Centre reporting no verified connections or recorded tests. |
| NEO-BKL-L11 | Administration | P2 | Reported issue — current reproduction pending | Go-live readiness gates missing or incomplete. |
| NEO-BKL-M01 | Guest experience | P2 | Reported issue — current reproduction pending | Public hotel listing showing KES 0 nightly rate. |
| NEO-BKL-M02 | Guest experience | P2 | Reported issue — current reproduction pending | Synthetic QA items appearing on the public dining menu. |
| NEO-BKL-M03 | Guest experience | P2 | Reported issue — current reproduction pending | Guest booking price breakdown not sufficiently clear. |
| NEO-BKL-M04 | Guest experience | P1 | Open verification gate | Guest reservation confirmation and payment journey not completely proved. |
| NEO-BKL-M05 | Guest experience | P1 | Open verification gate | Separation between demonstration, testing, and actual live operational information requires verification. |
| NEO-BKL-R01 | Finance | P0 | Already being fixed | Outstanding queue/gross totals misreported as revenue |
| NEO-BKL-R02 | Printing | P1 | Local source repaired; agent update and physical test pending | PTR-only advertisements did not resolve missing service/address records |
| NEO-BKL-R03 | Administration | P1 | Source fixes; real-device/native release evidence pending | Browser install/update privacy and native/store distribution |
| NEO-BKL-R04 | Administration | P1 | Source work exists; station/session end-to-end retest pending | Supervisor tools, separate logout and display switching |
| NEO-BKL-R05 | Administration | P2 | Partial source audit completed; remaining action inventory open | Hidden external page actions, local fonts and local-first summaries |
| NEO-BKL-R06 | Administration | P1 | Read-only evidence/access gate open | Protected Mawimbi configuration and reciprocal property isolation |
| NEO-BKL-R07 | Finance | P1 | Review required; do not rewrite posted history | Review historical bar room-charge revenue classification |
| NEO-BKL-R08 | Administration | P2 | Investigate identity mapping; no leak established | Public greeting and staff display-name disagreement |
| NEO-BKL-R09 | Administration | P1 | Configuration verification and delivery proof pending | Provider/sender evidence and password-reset inbox delivery |
| FIN-R01 | Finance / Selling departments | P1 | Existing requirement retained; verification/development pending | A configured selling price remains the customer payable price. Extract applicable included VAT/CTL; company-configurable rates and product applicability. No blanket CTL. |
| FIN-R02 | Finance / Selling departments | P1 | Existing requirement retained; verification/development pending | Company-specific enabled state, fixed/percentage limits, product/category/bill scope, combination rules and approvals. Preserve existing Operations Manager up-to-15% / Owner-above-15% authority where configured. |
| FIN-R03 | Finance / Selling departments | P1 | Existing requirement retained; verification/development pending | Kenyan companies account primarily in KES and display a USD equivalent from an Owner-approved configured rate. Snapshot that rate per transaction; historical reprints retain it. No external market-rate API or second sale is required. |
| FIN-R04 | Finance / Selling departments | P1 | Existing requirement retained; verification/development pending | Use active company-owned cash/M-Pesa/bank/card/other instructions, never hard-coded Mawimbi details. Show actual tender, received amount, balance, change and references, including split payments. |
| FIN-R05 | Finance / Selling departments | P1 | Existing requirement retained; verification/development pending | Existing receipt integration; company/branch/PIN/contact, transaction/table/room identifiers, item code/quantity/inclusive unit price, included taxes, discount, KES/USD totals, tender, staff and print time. Support 80 mm and supported 58 mm layouts. |
| FIN-R06 | Finance / Selling departments | P1 | Existing requirement retained; verification/development pending | Separate net revenue and tax liabilities; discounted included taxes reduce correctly; actual settlement accounts; deposits/unpaid/partial settlement; correct reversal of voids/refunds/cancellations. |
| FIN-R07 | Finance / Selling departments | P1 | Existing requirement retained; verification/development pending | Printing/reprinting must not mark a bill paid, repost a sale, create another tender/journal, or alter historical FX/tax facts. Distinguish bill/invoice from payment receipt. |
| FIN-R08 | Finance / Selling departments | P1 | Existing requirement retained; verification/development pending | POS, restaurant, bar, rooms, events and other selling points use consistent configured pricing/tax/discount facts through their existing paths. |

