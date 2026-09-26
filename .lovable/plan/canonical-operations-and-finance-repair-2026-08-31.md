# Canonical Operations and Finance Repair

## Goal
Repair the reported guest-stay, maintenance, restaurant, inventory, stores, procurement/AP, and End-of-Day chains so the database owns each business transition, downstream work is atomic or visibly queued, and every screen reads the same scoped state and amount.

## 1. Reservation, availability, and deposit chain
- Replace divergent room checks with one organisation/property/date/room-type/occupancy-aware availability contract used by Availability, reservation creation, room assignment, and check-in validation.
- Preserve a room selected from Availability through the reservation draft; revalidate it only at commit and clear it only when the database reports a genuine competing conflict.
- Make room assignment atomic and return an explicit persisted outcome instead of relying on a filtered UI list.
- Extend deposit recording so one idempotent deposit identity immediately creates or queues the guest-deposit liability posting; surface posted, queued, blocked, and failed outcomes consistently in Deposit Reconciliation and Finance Queue.

## 2. Maintenance and room lifecycle
- Add one authenticated atomic work-order creation routine that validates property scope, persists the work order and room link, blocks the room, records status history/audit, and returns the persisted work-order ID.
- Keep the dialog open on any failed business step and only show success after the complete result is verified.
- Preserve the working housekeeping inspection release path.
- Ensure checkout creates exactly one idempotent checkout-cleaning task and leaves the room unsellable until the configured cleaning/inspection lifecycle reaches Ready.

## 3. POS, KDS, cashier routing, and room charges
- Scope the sale catalogue to the order’s property—not merely the global property selector—and require one active property price, valid menu, and production station before an item can be sent.
- Reject Send atomically when any draft line cannot route; create/reuse KDS tickets and link every sent line in the same transaction.
- For recipe-controlled products, require a resolvable active property recipe and source-store mapping, then create idempotent consumption/reversal movements at the configured Served/Settled event.
- Make cashier routing create the payment attempt, collection task, assigned cashier/till, source order, amount/method, pending state, and audit evidence atomically.
- Correct room-charge posting to copy the POS canonical gross total exactly once while retaining source tax/service components as metadata; unify In-House, Stay, Folio, Receivables, and Finance on the canonical folio balance projection.

## 4. Stores, GRN, AP, and supplier payments
- Preserve the existing requisition shortage behavior, then verify partial issue/receipt and repeat-safe stock movement using one controlled UAT stock item.
- Make accepted GRN completion create or queue inventory quantity, valuation, GRNI receipt, financial state, and balanced journal with one posting identity.
- Derive AP matched amount from accepted invoice-line allocations and use the same result in the matching register, payable view, counters, and posting eligibility.
- Complete the supplier payment lifecycle with visible permission-gated actions: Scheduled → Awaiting Approval → Approved → Released → Paid/Failed → Journalised, including audit and idempotent posting.

## 5. Finance queue, reconciliation, and End of Day
- Make blocked/failed/ready counters projections of the exact queue/exception rows rendered beneath them.
- Add an End of Day action that first posts all eligible queue records, persists the audit-run record, snapshots PMS, POS, deposits, payments, tills, AP, AR, inventory/GRNI, journal totals, unposted records, and failed downstream events, then stores warning/blocking exceptions.
- Never claim completion when posting or snapshot persistence fails; return and display the failed stage.
- Keep General Ledger and Deposit Reconciliation linked to posting receipts, journal headers, debit/credit lines, till movements, and source records.

## 6. Permissions, migration safety, and UI outcomes
- Use effective capabilities and organisation/property scope in every new routine and action; do not grant authority by role name.
- Add only additive migrations, preserve existing identifiers/history, use advisory locks and unique posting identities, and keep all live tables protected by existing tenant-anchored access rules.
- Update mutation dialogs to close only on a verified completed result; queued/blocked/failed states remain visible with retry or source-resolution actions.

## 7. Verification and controlled live UAT
- Add contract and integration tests for shared availability, room handoff, atomic maintenance, station/KDS rejection, gross room-charge equality, deposit queueing, GRN/AP matching, payment lifecycle, and persisted End-of-Day snapshots.
- Run focused tests, type checks, and the required production smoke test.
- In the existing authorised tenant, create fresh uniquely labelled UAT records only for the requested chains: guest reservation/deposit/check-in/POS room charge/payment/checkout, one room-blocking work order, one partial stores issue, and one PO/GRN/invoice/payment chain.
- Trace each UAT source through its persisted downstream records and journal lines after refresh. Do not alter or delete prior operational records; report any chain that remains blocked rather than forcing data.

## Technical details
- Prefer transactional database functions for same-commit effects; use the existing domain-event/outbox contract only where asynchronous work is required.
- Canonical monetary handoffs use persisted gross totals and source component metadata; downstream modules must not recompute upstream tax.
- Idempotency keys are stable per source transition (`deposit:<id>`, `pos-room-charge:<order>`, `grn:<id>`, payment/source identities), protected by transaction locks and uniqueness constraints.
- All reconciliation summaries and drilldowns are generated from the same underlying rows and date/property scope.
