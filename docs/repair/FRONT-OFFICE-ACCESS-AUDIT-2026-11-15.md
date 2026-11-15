# Overview and Front Office access audit

All 24 user-listed Overview/PMS routes were evaluated against eight intended source role templates: Owner, Front Office Manager, Front Office Supervisor, Receptionist, Reservations Agent, Front Office Cashier, Porter and Driver. Existing role/navigation, department parity, worker-surface, configuration/device authority and reservation/folio boundary suites passed 272 tests. This verifies those source contracts, not live staff assignments or every operational workflow.

The sidebar already filters navigation by the canonical capability registry. This batch repairs these confirmed UI mismatches:

- `/pms/reservations/new` inherits reservation view authority in the route registry while its form requires reservation create authority.
- Front Office dashboard and reservation-directory create links are rendered without matching create checks.
- Movement-board empty-state create links can remain as inactive text inside button styling; reservation-row detail links are ordinary links.
- Shared metric cards can expose links to routes the viewer cannot open.

These controls now use the existing resolver. Route guards, RPC authorization, RLS and property/record scope checks remain. Denied record navigation remains plain context; create actions disappear when unavailable. Six targeted metric/create-route checks passed, alongside the broader role/navigation suites.

The supplied `finance-handoff-and-front-office-access-v1` inventory contains 228 installed role records. Comparing their grants with current source templates using `canFromPermissions` across all 24 routes found 1,703 route/role differences, including 69 for roles with assigned members. These are configuration differences, not 1,703 proven security failures: combined user roles, active membership and record RLS were not inspected. The assigned-role differences involve Receptionist and Front Office Manager. Some differences are missing source-template authority (for example Manager intelligence/report access), so revoking all live differences would be incorrect. Driver and Porter templates also have broader installed view grants in unassigned inventoried roles. No grant was changed by this comparison. Keep intended job responsibility, backend command checks and property/data scope aligned before reconciling templates.

Financial and document repairs remain active alongside this audit; no claim is made that every listed page and button is fully certified.
