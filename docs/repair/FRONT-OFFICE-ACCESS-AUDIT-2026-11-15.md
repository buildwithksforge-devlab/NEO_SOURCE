# Overview and Front Office access audit

All 24 user-listed Overview/PMS routes were evaluated against eight intended source role templates: Owner, Front Office Manager, Front Office Supervisor, Receptionist, Reservations Agent, Front Office Cashier, Porter and Driver. Existing role/navigation, department parity, worker-surface, configuration/device authority and reservation/folio boundary suites passed 272 tests. This verifies those source contracts, not live staff assignments or every operational workflow.

The sidebar already filters navigation by the canonical capability registry. Confirmed remaining UI mismatches include:

- `/pms/reservations/new` inherits reservation view authority in the route registry while its form requires reservation create authority.
- Front Office dashboard and reservation-directory create links are rendered without matching create checks.
- Movement-board empty-state create links can remain as inactive text inside button styling; reservation-row detail links are ordinary links.
- Shared metric cards can expose links to routes the viewer cannot open.

Repair these visible controls against the existing resolver. Keep route guards, RPC authorization, RLS and property/record scope checks. Preserve legitimate approval-request paths and record context; a denied navigation target can remain plain record text, but must not look clickable. Do not change employee grants based only on job-title assumptions. Live effective role/property assignments and action-to-backend agreement still need review.

Financial and document repairs remain active alongside this audit; no claim is made that every listed page and button is fully certified.
