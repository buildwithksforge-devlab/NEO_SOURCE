# Event Billing, Check-in Safety Net & Delivery Dispatch

Nine requests across three areas. Delivered in three stages so each one is verifiable before the next starts.

## Stage 1 — Event Billing before Finance treats balances as fact

- Authoritative billing routine that builds an event's billable position from its own records (package, menu, resources, vendors, change requests) instead of inferring it from quotations.
- Deposits, part-payments, credits and adjustments recorded against the booking, each with an actor, reason and timestamp.
- A single server-computed balance per event (charged, paid, outstanding) that Finance posting and the fact layer read — no client arithmetic.
- Event Billing screen: line items, payment history, record-payment action gated on the billing capability, and a clear "Not yet billed" state.
- Finance posting only accepts an event once billing is finalised; unbilled events show as ineligible with the reason.

## Stage 2 — Check-in integrity

- **Revert check-in**: one transactional routine that undoes an accidental check-in — reservation returns to its prior status, the stay is voided, the folio is reversed (never deleted), the room returns to its pre-check-in condition, and the timeline records the reversal. Blocked when charges have been posted or the folio settled; requires a reason and is capability-gated.
- **Integration tests**: automated coverage of the whole check-in path — stay creation, folio open, room occupancy, guest-history and timeline writes, in-house count movement — plus the revert path returning every one of those to baseline.
- **Reconciliation monitor**: a routine that compares occupied rooms, open stays, open folios and the in-house count after each check-in, records any drift with the affected records, raises an operator alert in the existing commitments/notification inbox, and writes an audit entry. Surfaced as a status strip on Front Office.

## Stage 3 — Delivery dispatch, riders and audit

- **Assignment screen**: unassigned orders on one side, eligible riders on the other. Eligibility is server-decided (rider capability, on-duty shift, active-order ceiling, property scope, cash handling when the order is cash) with the reason shown for anyone ineligible. Live refresh of availability.
- **Availability and shifts**: rider shift schedule (on-duty windows per rider per property) plus their self-reported availability; only riders whose shift is live are selectable, and the roster shows on-duty/off-duty at a glance.
- **Audit log**: every roster add, reinstate, retire and every dispatch/reassignment recorded with actor, rider, order, reason and time, viewable from the roster.
- **Performance metrics**: on-time rate, completed deliveries, cancellations and average delivery time per rider, computed server-side over a chosen window, shown on the roster and used to sort dispatch candidates.
- **Rider notifications**: queued messages to the rider on assignment, reassignment, and rider-code/status change, using the existing notification templates and queue.

## Technical notes

- All state changes go through SECURITY DEFINER routines with property-scope and capability checks; the browser never writes billing, folio, roster or dispatch state directly.
- New tables (event payments, rider shifts, rider/dispatch audit) get GRANTs, RLS and property-scoped policies in the same migration; all migrations additive.
- New routines are registered in the RPC manifest; new capabilities are added to the role feature templates and recompiled for every workspace.
- Tests extend the existing vitest suites (contract, lifecycle, capability matrix).
