# Owner-UAT structural repair — financial state, payables and authority

This is one architectural correction delivered in five stages. Each stage ends with a working, testable system; nothing is left half-migrated between stages.

## The single idea behind all seven findings

Today a transaction's *operational* state and its *accounting* state are stored and displayed as one thing, so "Posted" can mean five different things in five places. Every finding below follows from that. The repair introduces one canonical financial-state record that every module writes to and every screen reads from.

```text
Source transaction (GRN, POS order, folio, event, laundry, invoice, payment,
refund, deposit, adjustment, wastage, return)
        |
        v
Financial posting record   <-- one row per source, one vocabulary
  status: not-applicable | pending | eligible | blocked | failed | posted | reversed
  reason, amount, property, accounting date & period, actor, attempts
        |
        v
Journal header  ->  Journal lines   (debits = credits, always)
```

Operational status stays on the source record and keeps its own words (Draft, Receiving, Received, Reversed). The two are never merged, and no screen shows "Posted" without saying which kind.

## Stage 1 — Canonical financial state (findings 1, 4, 7)

- One financial-state table keyed by (module, source record), with the seven statuses above, the blocking reason, the resolved amount, property, accounting date/period, actor, attempt history and journal link.
- Every existing posting path (POS, folios, events, laundry, GRN, supplier invoice, supplier payment, refunds, deposits) writes its outcome there instead of into module-specific flags. Existing queue and receipt rows are back-filled, not dropped.
- A shared posting guard runs before any journal is written: source exists, lines exist, line sum equals header total, not cancelled/voided, settlement evidence valid, no duplicate posting. Failure sets Blocked with reason `Source integrity mismatch` and writes nothing.
- Journal register and Finance dashboards read only this table, so a figure on a dashboard is always clickable through to the journal or to the exact blocking reason.
- UI vocabulary split: badges read "Received" / "Operationally posted" / "GL posted" — never a bare "Posted".

## Stage 2 — GRN to General Ledger, end to end (finding 1)

- GRN detail gains a Financial status panel: status, reason, accrual amount, journal link, resolution action, attempt history — beside, not merged with, the operational status.
- Inventory recognition and GRNI accrual become one idempotent posting step through the Stage 1 guard, with accounts resolved from the Chart of Accounts.
- Reversal of a receipt reverses its posting record and journal, keeping both rows.
- Reconciliation categories cover inventory receipts, supplier invoices and supplier payments alongside POS, folios, events and laundry.

## Stage 3 — Supplier invoices and Accounts Payable workspace (findings 2, 3)

- One canonical `/finance/payables` workspace: capture, list, detail. Capture covers supplier, supplier invoice number, dates, terms, currency, PO reference, one or more GRNs, line quantities and prices, tax, discounts, totals and attachments.
- Duplicate detection on supplier + supplier invoice number, surfaced before submission.
- Line-level three-way match producing explicit outcomes: Matched, Quantity variance, Price variance, Tax variance, Goods not received, Payment hold. Many-to-many PO/GRN/invoice relationships throughout — never a fixed 1:1:1.
- Configurable quantity and price tolerances (per item category, overridable per PO line); within tolerance auto-matches, outside tolerance holds.
- Exception approval with approver, reason and variance retained in the audit trail. PO 100 / GRN 90 / invoice 100 cannot become a payable for 100 without a recorded resolution.
- Payable balance, payment history, credit notes and reversal history on the invoice record.

## Stage 4 — Finance capabilities and authority (findings 5, 6)

- Replace broad `finance.view` / `finance.edit` with granular capabilities: dashboard, ap (view/create/edit/match), journal (view/create/post), gl, reconciliation (view/perform), payment (prepare/approve), period (view/close), coa (view/manage).
- Route table, sidebar, dashboard cards and deep links all resolve through the same registry, so Accountant reaches AP, Chart of Accounts and reconciliation without Owner help.
- Data scope (own → assigned → outlet → department → property → organisation → group) stays independently configurable from action authority (view, create, edit, submit, approve, reject, post, reverse, configure, close). An Accountant can read organisation-wide while being unable to approve payments, close periods or change accounting settings.
- Role templates updated for Accountant and Finance Manager; self-approval remains blocked.

## Stage 5 — Verification and the requested supporting work

- Notification inbox goes real-time for Housekeeping and Front Office events with live read/unread state.
- Configurable notification templates and message formatting, filtered by property and status transition.
- A deep-link validation suite that walks every header action, dashboard card and link and fails the build if any targets a route the acting role cannot open.
- Trace tests: one GRN and one POS order each traced from source through inventory/settlement, posting record, journal and reconciliation with a single consistent amount.

## Technical notes

- All schema work is additive: new tables and columns, back-fill from existing rows, no DROP/TRUNCATE on live tables, all UUIDs and audit history preserved.
- New tables get GRANTs plus organisation-anchored RLS (`organization_id = current_org_id()` / `is_org_admin_for(...)`), never a bare admin bypass.
- Posting routines stay `SECURITY DEFINER`, authenticated-only, and registered in the RPC manifest.
- Each stage ships with its own tests in `src/lib/__tests__` and must keep the existing suite green.

## Sequencing

Stages run in order — 2, 3 and 4 all depend on the Stage 1 state model. I will pause for your review at the end of each stage before starting the next.
