# Canonical State, Finance Posting, and End-of-Day Repair

## Goal
Make lifecycle state, Finance posting, reconciliation, and End of Day read one persisted source of truth so operational screens cannot claim completion when accounting or downstream work is unresolved.

## 1. Canonical transaction state
- Add an organisation/property-scoped canonical transaction register plus append-only transition history.
- Add one database writer that records source identity, operational state, financial state, actor, amount/currency, idempotency identity, blocker, next action, downstream references, and monotonically increasing version.
- Attach state projection triggers to the currently contradictory lifecycle sources: goods receipts, events, rooms, requisitions, payments, POS orders, reservations, maintenance work orders, supplier invoices, and supplier payments.
- Normalize module aliases such as `inventory` / `inventory-receipt` so every source has one canonical identity.

## 2. Finance posting and reconciliation
- Repair GRN eligibility so an operationally posted/accepted GRN with no accrual journal is Finance-eligible, while a GRN with a balanced linked journal is canonically posted.
- Fix the invalid JSON operator applied to the text posting-receipt detail field.
- Keep one current posting receipt per canonical source identity and add append-only receipt history for every eligibility, blocked, failed, posted, retry, and reversal change.
- Rebuild the posting queue, exception register, dashboard counters, drilldowns, and reconciliation export from canonical transaction state plus posting receipts and balanced journal evidence.
- Treat a receipt as posted only when its linked journal exists and balances; surface missing/unbalanced journal links as blocking exceptions.

## 3. Persisted End of Day
- Replace the invalid `approval_requests.request_number` reference with the real canonical `reference` field.
- Extend each Night Audit run with persisted stage, source counts, exception snapshot, rerun count, completion timestamps, and a deterministic signed result digest.
- Preserve every rerun as an append-only attempt record while keeping one stable daily audit identity.
- Build EOD blockers from the same Finance exception register used by posting and dashboards.
- Refuse Close Day unless the selected run completed, has zero blocking exceptions, and canonical reconciliation has no unresolved eligible/blocked/failed posting records.

## 4. Application alignment and verification
- Update frontend types and EOD/posting status presentation to expose persisted stages and signed outcomes without introducing separate calculations.
- Add regression coverage for GRN 002-style state convergence, receipt/journal balance validation, authoritative counters, the text/JSON operator failure, EOD approval references, rerun persistence, and close blocking.
- Run focused tests and the required production smoke test. No live operational data will be created as part of this repair.

## Technical details
- All database changes are additive and organisation/property anchored; existing identifiers, journals, audit history, and operational records remain intact.
- Transition and receipt histories are append-only; current-state tables are projections updated idempotently under advisory locks.
- Existing operational status fields remain compatibility projections, but workflow and Finance surfaces read the canonical register.
