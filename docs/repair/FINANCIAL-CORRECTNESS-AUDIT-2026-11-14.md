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
New document/arithmetic edits are local and not deployed. Shared-workspace 23-routine installer was confirmed installed separately. Two pending POS migrations must be installed before their dependent client changes deploy.
