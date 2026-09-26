# Role, permission and dashboard redesign — progress ledger

## Stage 1 — Access scope foundation (DONE)
- `roles.access_scope` (organisation | branch | department | team | self | technical),
  defaulted per role name by `role_scope_level()` when unset. Additive; no role rows changed.
- Identity resolvers: `current_staff_id()`, `current_branch_ids()`, `current_department_ids()`,
  `current_station_ids()`, `current_access_scope()`, `supervises_user()`, `manages_department()`.
- Master predicate `in_my_scope(org, branch, department, station, assigned_user, created_by)`.
- `record_assistants` (explicit per-record sharing) and `work_transfers` (immutable handover trail),
  both with RLS + GRANTs.
- All new SECURITY DEFINER helpers: `EXECUTE` revoked from PUBLIC/anon, granted to `authenticated`.

## Stage 2 — Scoped RLS on operational tables (DONE)
Replaced organisation-wide reads with `in_my_scope` on:
`pos_orders`, `pos_order_items`, `station_tickets`, `housekeeping_jobs`, `delivery_orders`
(staff paths), `maintenance_work_orders`, `cash_drawers`, `pos_shifts`.

Effect: a waiter sees only their own orders; a chef only their station's tickets; a room
attendant only their assigned jobs; a rider only their deliveries; a cashier only their own
drawer and shift. Supervisors see their team, department managers their department, GMs their
property, owners the organisation. Writes follow the same predicate, so a direct API call
cannot reach another employee's records.

## Stage 3 — Session context (DONE)
- `my_access_context()` returns the caller's organisation, branches, departments, stations,
  scope level, roles, account status and whether assignment is complete.
- `AuthProvider` exposes `access` / `accessLoaded`; cleared on sign-out, refreshed with permissions.
- `WorkplaceSetupNotice` replaces empty dashboards with "Account setup required" when a
  non-admin has no property/department/role assignment.

## Remaining
- Extend `in_my_scope` to the remaining operational tables (folios, guest_requests,
  internal_requisitions, attendance, expense claims).
- Surface shift/station context and supervisor "assist" and "transfer" actions in the UI.
- End-to-end verification with real non-admin staff logins (still blocked without credentials).
