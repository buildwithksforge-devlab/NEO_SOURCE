# Financial correctness audit — 2026-11-14

Status: in progress. This is not certification of all Finance calculations or historical balances.

## Confirmed defects and local repairs
1. Folio PDF used stored summary columns while preview used `neo_folio_projection`. Download now requests the same scoped projection and refuses absent/invalid financial values. No balance is rewritten.
2. Preview showed `folio_lines.gross_amount` as the payable line amount. The database amount invariant defines `gross_amount - discount_amount + tax_amount + service_charge_amount = net_amount`. Preview now shows `net_amount`; both statement paths exclude void/reversed lines and separate payment/deposit/refund rows from charges.
3. `balancesGross` omitted service charge. Includes it now and refuses non-finite evidence and a one-cent difference.
4. `journalTotals` could accept Infinity on both sides as balanced; it also did not reject negative or two-sided lines. Local repair validates finite, nonnegative, one-sided currency-cent amounts before marking a journal balanced.

## Verification performed
- Nine existing focused financial suites: 122 tests passed.
- Follow-up arithmetic regression suites: 34 tests passed, including six new invalid-journal cases and service-charge/one-cent checks.
- These tests check specific frontend/domain contracts, not all database accounting routines or production history.
- Earlier TypeScript run passed; final run after subsequent edits pending.

## Remaining required review
- Folio line generation, discounts/tax-inclusive and exclusive calculations, service charge, reversal and refund signs.
- POS line/order rounding, discount allocation, tax/service totals and split/partial settlement.
- Reservation deposits and applied-deposit/payment links: no duplicate collection recognition, correct remaining headroom.
- M-Pesa verified receipt application across entry points, overpayment handling and pending-attempt reconciliation.
- Supplier invoice and payment quantities/amounts, VAT, three-way match, GRNI and payables journal links.
- Receiving/returns/stocktake and issue/consumption cost-unit conversions and Finance posting evidence.
- Trial balance, cashbook, ledger, receivables/payables, earned-revenue reconciliation: period/currency/sign consistency.
- Detect rather than rewrite any historical inconsistencies; any financial recovery needs exact supporting evidence.

## Deployment status
Initial document/arithmetic changes and POS dependencies are deployed in commit `8a5cfa6`, Worker version `df612086-86b5-4b11-bac6-27937ba849b9`. The user confirmed both POS routines, column and four triggers installed. Release checks: 323 regression tests, TypeScript, production build and smoke passed. Live assets match and unauthenticated payment/PIN/callback probes were rejected. This is release evidence, not end-to-end accounting certification.

## Installed calculation definitions reviewed after deployment
The user returned `financial-calculation-contracts-v1` with eleven installed routines and fingerprints. These supersede older migration bodies when auditing live behavior.

- **Preserve existing repair:** installed `delivery_quote_cart` already extracts inclusive tax and does not add it again to grand total. The older repository migration differs. Do not restore that older body. Installed POS totals also already zero an empty bill correctly.
- **Confirmed room-service handoff defect:** `neo_guest_place_room_service` passes inclusive subtotal less discount as folio base, then separately adds tax through `folio_post_charge`. For a tax-inclusive 116 sale with tax 16, the resulting folio charge becomes 132 before service charge. This is a future-call defect; do not rewrite historical bills without evidence. Tips also need separate classification and reconciliation before claiming the complete handoff fixed.
- **Modifier parity gap:** delivery quote adds cart modifier prices into subtotal, but order creation writes base menu quantity × price as line total and inserts modifiers separately. No modifier-trigger definition has yet been found that reconciles that amount. Confirm trigger inventory before replacing the chain; the newly installed atomic-selection mechanism is available for the eventual handoff repair.
- **Currency defect:** delivery order creation temporarily uses preferred language as currency then forces KES; room-service creation also forces KES. Property currency must govern these paths, with M-Pesa remaining KES-only by its own contract.
- **Retry identity defect:** converted-cart recovery selects the customer's latest delivery order rather than an order bound to that exact cart. Different carts can be confused on retry. An exact durable cart-to-order relationship is required.
- **Pending-collection discount review:** installed discount command does not itself lock the order before reading or check open provider attempts. Confirm existing order triggers and discount authority before changing it; preserve approved void/refund workflows.
- **Tax extensibility gap:** Finance tax codes have configured rates/treatments/effective dates/accounts, while menu lines use an effective numeric tax rate and POS settings expose a service percentage. Adding a Finance tax code alone is not proof that every sales entry point uses it. Configuration-to-charge-component mapping, rounding, posting and documents require further explicit work.

## Follow-up document/report repair
Report PDFs now distinguish invalid facts from genuine zeroes, require a known currency and wrap long values. Ten new report formatter regression cases pass. This repair is included with the shared A4 layout correction described in `DOCUMENT-LAYOUT-2026-11-15.md`. The release build, TypeScript, smoke and 323 regression checks passed; deployment is recorded separately. No additional backend monetary routine is changed by this follow-up.
