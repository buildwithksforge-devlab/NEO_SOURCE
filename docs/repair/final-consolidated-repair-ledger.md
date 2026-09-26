# NEØ Final Consolidated Permanent Solution — durable progress ledger

Authoritative resume point. Each run appends evidence; never repeat completed items.

## Stage 1 — Authentication, dynamic permissions, scope, ownership, audit identity

| Req | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1.1 | Atomic authentication bootstrap state machine | DONE | `AuthPhase` in `src/lib/auth.tsx` (signed-out → authenticating → resolving-account → resolving-access → ready, plus setup-incomplete / suspended / denied / error). `WorkspaceBootGate` wraps `AppShell`, so no protected screen mounts before Ready. |
| 1.2 | Complete logout / account-switch cleanup | DONE | `clearWorkspaceState()` cancels in-flight queries, clears the query cache, removes all realtime channels, clears roles, permissions, org/property/department/station, staff context, tenant-prefixed localStorage and all sessionStorage. Runs on SIGNED_OUT, on explicit sign-out and on user switch before the next context loads. |
| 1.3 | One effective-access contract | DONE | `public.my_effective_access()` returns user id, account type/status, organisation, permitted properties, active property, departments, stations, role ids/names, canonical permissions, individual grants, individual denials, module entitlements, dashboard assignment, access scope, setup state and access version. `AuthProvider` is the single consumer for the UI. |
| 1.4 | Dynamic canonical permissions incl. temporary grants | DONE | `user_permissions` gained `valid_from`, `valid_until`, `reason`; `my_effective_permissions()` honours the validity window and denies everything for a non-active account. Precedence: account status → org scope → individual denial → individual grant → role grant → deny. Role names are labels only. |
| 1.5 | Record ownership / manager visibility | PARTIAL (Stage-2 of earlier redesign) | `in_my_scope()` applied to pos_orders, pos_order_items, station_tickets, housekeeping_jobs, delivery_orders, maintenance_work_orders, cash_drawers, pos_shifts. Remaining: folios, guest_requests, internal_requisitions, attendance, expense claims. |
| 1.6 | Account-type & scope separation | PARTIAL | `account_type` now surfaced in the access contract for gating; selectors still to be filtered to effective assignments only. |
| 1.7 | Truthful page outcomes | DONE (shell level) | Boot gate renders exactly one of Loading / Access Denied / Setup Incomplete / Recoverable Error; `RouteAccessGate` no longer passes unresolved sessions through. |
| 1.8 | Audit accountability | DONE | `public.log_audit_event()` stamps the backend actor, staff name, roles at time of action, org/property/department/station, permission used, correlation id and delegation context. `src/lib/audit.ts` now calls it; the browser can no longer supply an actor id. |

### Access version
`my_permission_version()` now fingerprints account status/type, org, property, department,
role set, role permission counts, individual grants incl. validity windows, branch/department/
station assignments and entitlements — so an administrator change reaches a live session
within the existing 60 s poll / focus check.

### Rollback
All Stage 1 migrations are additive: drop `my_effective_access()` and `log_audit_event()`, and
drop the added `user_permissions` / `audit_logs` columns to return to the previous behaviour.
No rows were modified, no UUIDs changed.

## Next executable action
Stage 1 remainder: filter property/department/station selectors to effective assignments and
hide Customer Portal navigation from staff accounts; then extend `in_my_scope()` to folios,
guest_requests, internal_requisitions, attendance and expense claims.

Then Stage 2 (rooms, front office, housekeeping, maintenance, laundry) per the consolidated
prompt, Stage 3 (POS, menu, kitchen, stock, procurement, finance) and Stage 4 (HR, events,
delivery, settings, branding, reporting, readiness).

## Stage 1 remainder — selector scoping and scope-aware RLS coverage (DONE)

| Item | Status | Evidence |
| --- | --- | --- |
| Property selector shows only effective assignments | DONE | `useBranchScope()` in `src/lib/branches.ts` now derives `orgWide` from `access.accessScope === 'organisation'` (or admin) and filters the list to `access.branchIds`. The old rule — "no branch pinned means every property" — is gone, so an unassigned staff account no longer sees the whole estate. |
| `in_my_branch_scope(org, branch)` helper | DONE | Property-level predicate for shared records without a department column. `SECURITY DEFINER`, fixed search path, `EXECUTE` revoked from PUBLIC/anon, granted to `authenticated`. |
| Folios scoped | DONE | `staff_read_folios` / `staff_update_folios` / `staff_insert_folios` now require `in_my_branch_scope`. Guest self-read policy untouched. |
| Guest requests scoped | DONE | `staff_read_guest_requests` / `staff_update_guest_requests` use `in_my_scope(org, branch, department, station, assignee, created_by)` — own, station, department, supervised or property. |
| Internal requisitions scoped | DONE | `internal_requisitions_select` uses `in_my_scope(..., requested_by, requested_by)`. |
| Expense claims scoped | DONE | Read/update use `in_my_scope`; a claimant can always read their own claim regardless of finance permission. |
| Attendance | ALREADY COMPLIANT | `attendance read` was already self / team / all-view gated via `hr_is_self` + `hr_is_team_member`; left unchanged. |

Verified: typecheck clean, workspace boots and renders for an organisation-scoped account with no
console errors after the policy change.

### Rollback
Drop `in_my_branch_scope` and restore the previous organisation-wide `USING (organization_id =
current_org_id())` policies on the five tables. Purely policy-level; no data touched.

## Next executable action
Stage 2 (rooms, front office, housekeeping, maintenance, laundry) of the consolidated prompt.

## Stage 1 close-out + Stage 2 (rooms, front office, housekeeping, maintenance, laundry) — scope enforcement

| Item | Status | Evidence |
| --- | --- | --- |
| Staff / customer navigation separation | DONE | `WorkspaceBootGate` now refuses to mount the staff workspace when the backend access contract reports a non-staff `account_type`, whatever route was requested. Decision comes from `my_effective_access()`, never from a role name or the URL. |
| Owner vs platform/system administrator separation | DONE | New `public.in_my_config_scope(org, branch)`: a `technical`-scope administrator keeps configuration data (rooms, room types, room assignments, assets) but stays outside guest-operational records (reservations, folios, guest requests, laundry). Property-scoped staff are unaffected. |
| Rooms / room types / room assignments scoped | DONE | Read, insert and update now require `in_my_config_scope`; room updates additionally accept `housekeeping.edit` so room-condition changes work for housekeepers. |
| Reservations & front office scoped | DONE | `staff_read_reservations` = `in_my_branch_scope OR created_by = auth.uid()`; writes require property scope + `pms.write` and a matching `WITH CHECK`, so a record cannot be moved out of scope. Verified live: signed-in property-scoped admin sees 1 of 4 reservations — the 3 belonging to the other property are blocked. |
| Housekeeping deep cleaning + job results scoped | DONE | Deep cleaning is property-scoped; `housekeeping_job_results` now inherits the visibility of its parent job (which is already `in_my_scope` + share-aware), so results can never leak past the job. |
| Maintenance work orders + assets hardened | DONE | Work-order updates now use the same scope predicate as reads plus a maintenance permission, with a property `WITH CHECK`; asset reads use config-or-department scope, writes are property-bound. |
| Laundry scoped | DONE | `guest_laundry_orders` = property scope OR own assignment/creation; `guest_laundry_items` follow their order for read, insert and update. |
| Folio / guest-request / requisition / attendance / expense-claim scope | DONE (earlier run) | Unchanged; re-verified live — all return scoped counts with no permission errors. |

### Live verification (signed-in session, Playwright)
Account: System Administrator, `access_scope = technical`, one assigned property.
- `/pms/rooms`, `/housekeeping`, `/laundry`, `/maintenance`, `/pms/reservations` all render with zero
  failing network requests and no console errors after the fix below.
- Scoped read probe through the app's own client: rooms 11 (own property), reservations 1 of 4,
  housekeeping_jobs / laundry / assets / folios / guest_requests / internal_requisitions /
  expense_claims all returned scoped results with no RLS error.
- Regression found and fixed while verifying: `RESERVATION_SELECT` in `src/lib/pms-data.ts` embedded
  `corporate_accounts(company_name)`, a column that does not exist — every reservations list was
  returning HTTP 400. Now `legal_name, trading_name`; consumer in
  `src/routes/_shell.pms.reservations.$id.tsx` updated.

### Files changed
`src/components/layout/WorkspaceBootGate.tsx`, `src/lib/pms-data.ts`,
`src/routes/_shell.pms.reservations.$id.tsx`.

### Migrations
1. Scope policies for rooms, room_types, room_assignments, reservations, deep_cleaning_schedules,
   housekeeping_job_results, assets, maintenance_work_orders, guest_laundry_orders, guest_laundry_items.
2. `in_my_config_scope()` + configuration-data policies for the technical administrator separation.

### Rollback
Policy-only. Restore the previous `organization_id = current_org_id()` predicates and drop
`in_my_config_scope()`. No rows, UUIDs or audit history touched.

### Not yet done (honest remainder)
- Same-role worker isolation and manager-vs-worker comparison have only been verified for the one
  signed-in administrator account available in this environment; a second, department-scoped test
  account is required to prove the negative case end to end.
- Housekeeping supply-request routing and laundry transfer tracking still use their existing
  organisation-level tables; scope predicates exist for the tables that carry a property column.
- Stage 3 (POS, menu, kitchen, stock, procurement, finance) and Stage 4 (HR, events, delivery,
  settings, branding, reporting) scope passes are untouched by this run.

## Next executable action
Create a department-scoped test staff account, sign in as it, and record the negative-case evidence
(no cross-property rooms, no other worker's housekeeping jobs, no other property's reservations);
then begin the Stage 3 scope pass on POS/kitchen/stock/procurement/finance.

---

## Approval lifecycle unification (22 August 2026)

**Finding.** Two live records showed "Pending — Level 1" on the approvals page
while their notifications read "Resolved". Root cause: decisions were written
from the browser with `approval_requests.update`, and the RLS update policy only
admits the requester, the named approver or an org admin. Kofi Mensah Otieno was
none of these, so the status update silently matched zero rows while the
`approval_actions` insert (a separate statement) succeeded. Chain progression,
notifications, tasks and downstream execution each carried their own idea of
state, and duplicate clicks appended duplicate decisions (four on the purchase
order, three on the void).

**One authoritative model.**
- Request status: `draft`, `pending_approval`, `approved_pending_execution`,
  `executing`, `completed`, `rejected`, `cancelled`, `execution_failed`. A
  `BEFORE INSERT OR UPDATE` trigger translates legacy values (`pending`,
  `approved`, …), so existing writers keep working.
- New `approval_steps` (one row per level): `waiting`, `active`, `approved`,
  `rejected`, `skipped`, `cancelled`, with decider and decision time. Steps are
  seeded on insert and were backfilled for existing requests.
- Status is derived from steps plus the execution result. The notification's
  resolved flag is no longer an input to any status anywhere.

**Transactional decision.** `public.neo_approval_decide(request, action, comment,
idempotency_key)` locks the request and the active step, verifies approval
authority and step assignment, rejects self-approval, claims an idempotency key
(`automation_idempotency_keys`, scope `approval-decision`), appends the decision,
resolves the current notification and approval task, activates the next level
with its own actionable notification, or finalises the chain and calls
`public.neo_approval_execute` exactly once. Execution failure sets
`execution_failed`, records the error and opens a retryable row in the new
`approval_execution_failures` queue — it never returns to `pending_approval`.
`public.neo_approval_retry_execution` re-runs it. Rejection cancels all remaining
waiting levels and executes nothing. Every branch writes an attributable
`audit_logs` entry.

**Query rules.** Pending shows only `pending_approval` requests whose active step
is visible to the signed-in approver (and never their own). My Requests is split
into awaiting approval / awaiting execution / execution failed / completed /
rejected / cancelled, and the active count excludes completed. Tasks leave My
Tasks on completed, cancelled, rejected or superseded. Action-required notices
require `action_required`, an unresolved status, and — for approvals — a request
that still has an active step. Counts come from request status
(`public.neo_approval_counts()` is available server-side for the same figures),
never from notification rows. The old `neo_notify_approval` update branch, which
blanket-resolved and re-created notices on any status change, was removed.

**Reconciliation from evidence (no row deleted, no timestamp altered).**
- Purchase order "fruits", KES 78,900, Kofi Mensah Otieno requester: level 1 was
  approved 22 Aug 06:06:55 (earliest recorded decision; the three later
  duplicates are retained as history). Level 1 marked approved, level 2 activated,
  request now reads "Pending — Level 2 of 2" and has left level 1's inbox. No
  purchase action executed, because the chain is not finished.
- Void "ERROR", KES 23,000, Nia Wambui Githinji requester: the first recorded
  decision was a rejection 22 Aug 06:07:15 by Kofi Mensah Otieno. Request marked
  `rejected`, no void executed, later conflicting entries preserved as history.
- Void "We did the order twice" (APP-2026-000001): no decision on record, left
  `pending_approval` at level 1 of 2.
- Three "Request pending_approval" notices generated by the migration itself were
  removed; a level-2 actionable notice was raised for the purchase order.

**Changed.** Tables `approval_steps`, `approval_execution_failures`; columns on
`approval_requests` (`source_module`, `source_record_id`, `execution_status`,
`execution_error`, `executed_at`, `completed_at`, `cancelled_at`); functions
`neo_approval_normalize_status`, `neo_approval_seed_steps`, `neo_approval_execute`,
`neo_approval_decide`, `neo_approval_retry_execution`, `neo_approval_counts`,
`neo_notify_approval`; RLS read policies for both new tables (writes only through
the definer routines); UI `_shell.approvals.tsx`, `_shell.tasks.tsx`,
`_shell.notifications.tsx`; status filters in `dashboard-data.ts`,
`boot-prefetch.ts`, `automation-engine.server.ts`, `finance-data.ts`,
`crm.corporate.tsx`; `rpc-manifest.ts`.

**Tests.** New `src/lib/__tests__/approval-lifecycle.test.ts` (12 cases: state
model, active-level inbox visibility, resolved chains never in an inbox, level
reported as the active level, task queue hygiene, decisions only through the
routine, idempotency key present, retry path present, no legacy `pending`
filters, action-required derived from live chains). Full suite: 234 passing.

**Remaining limitations.**
- Downstream execution is wired for purchase requests (via
  `purchase_requests.approval_request_id`) and POS voids carrying
  `source_module = 'pos'`. Other approval types complete with
  `execution_status = 'not_required'` until their source records carry a
  `source_module` / `source_record_id` link.
- Level approvers are resolved per step from `approver_user_id`; where a step has
  no named approver the level is visible to every holder of approval authority.
  Role-based step routing from `approval_rules` is not yet applied at activation.
- Live sign-in verification of the Users page as Kofi Mensah Otieno could not be
  performed this turn: no authenticated preview session was available
  (`signed_out`), and that account's credentials are not held here.

## Authoritative reporting-line model

**Symptom** — "Reports to" in Edit Assignment offered no eligible managers: the
line was stored on `employees`, and almost no staff account had an employee row.

**Repair**
- `role_catalogue` / `roles` gained `management_level`, `reports_to_role_keys`,
  `can_manage_role_keys`, `managerial_scope`, `reporting_manager_required`
  (per-organisation overrides on `roles`). `can_manage_role_keys` is derived as
  the inverse of `reports_to_role_keys`, never hand-kept.
- Missing canonical roles added (general-manager, maintenance-officer,
  bar/restaurant/coffee/hot-kitchen supervisors, stores-manager) plus aliases;
  live `roles.normalized_role_key` normalised onto the catalogue.
- The line itself now lives on the staff account: `profiles.reporting_manager_id`,
  `reporting_effective_from`, `assignment_review_required/_reason`.
- `neo_guard_reporting_line()` trigger refuses self-reporting, cycles (recursive
  walk), cross-organisation managers and inactive/suspended managers.
- `neo_role_reporting_meta(role_ids)` resolves effective rules;
  `neo_reporting_candidates(user, branch, department, station, role_ids)`
  returns live, in-scope, cycle-safe candidates. Both are org-scoped
  SECURITY DEFINER, revoked from PUBLIC/anon.
- `neo_backfill_reporting_lines(org)` audited every active staff account:
  linked only where exactly one eligible manager existed, otherwise flagged
  "Assignment review required" with the reason. Result: 20 linked, 2 ambiguous,
  10 missing a manager-role holder. No id, role or history changed.

**Interface** — the Edit Assignment selector calls the candidate RPC keyed on
the currently selected roles, department, property and station, so the list
updates immediately. Names and job titles are never used to resolve a manager.
`updateStaffAssignment` re-validates the chosen manager against the same RPC
and audits the previous and new line.

**Not authorisation** — a reporting line narrows managerial visibility only;
capability and scope enforcement are unchanged (`neo_reports_to_me()` is a
supporting predicate, not a grant).

## Room availability & housekeeping readiness state machine — executed

**Authoritative contract.** `public.ops_room_state(_branch)` is the single read model for
room condition, readiness and sellability. It returns `housekeeping_state`,
`readiness_state`, `pending_inspection`, `sellable_now` and `exclusion_reasons[]`.
`public.ops_room_availability(_branch, _from, _to)` extends it over a date interval
(reservations, assignments, holds, blocks, out-of-order periods) using half-open
`[arrival, departure)` semantics. `public.pms_available_rooms` enforces the same
readiness rules, so the availability screen and the rack can no longer disagree.

**Derivation.** `rooms_derive_state()` derives inspection state rather than storing an
orphan: a room that becomes dirty resets to `not-required`, a failed inspection becomes
`rework_required`, and `sellable` requires clean/inspected **and** passed/not-required
inspection **and** operational maintenance **and** vacant occupancy **and** active inventory.
`hk_canonical_condition` now covers `cleaning_queued` and `rework`.

**Vocabulary.** `src/lib/operations.ts` exposes seven canonical states — dirty,
cleaning_queued, cleaning_in_progress, awaiting_inspection, rework_required, ready,
out_of_service — plus `roomHousekeepingState(row)`, which always prefers the derived
state. Clean and awaiting-inspection are no longer conflated.

**Surfaces updated.** Housekeeping dashboard, Room Board, PMS Rack and Availability all
read the same model. Counts report Ready/sellable, Dirty, Cleaning queued, Cleaning in
progress, Awaiting inspection, Rework required, Maintenance blocked and Out of service on
separate axes, and render `…` while loading instead of a false zero. Availability keeps
the operator's submitted arrival/departure, room type and party in the URL and never
substitutes today.

**Reconciliation.** `public.ops_room_state_reconciliation(_branch)` reports rooms whose
stored state disagrees with cleaning-task, inspection or maintenance evidence. It is
read-only and surfaced on the Housekeeping dashboard as "State reconciliation".

**Verification.** 265 tests pass, including
`src/lib/__tests__/room-readiness-contract.test.ts` (vocabulary, derivation rules,
overlap semantics, availability-search durability, RPC manifest). Live Zawadi Springs
Nairobi: 12 rooms — 9 sellable, 1 dirty (103), 1 maintenance blocked (104), 1 out of
service (108), 0 awaiting inspection. Availability search retained `2026-09-10` →
`2026-09-13` through submission.

**Next executable action if interrupted:** prove the full cleaning lifecycle in the
preview (raise task → start → complete → inspect pass/fail) and confirm the assignee
notification is delivered and the rack flips to Ready only after a pass.

---

## Finance posting lifecycle — automated evidence and shared-scope equality

**Security blocker.** `security--run_security_scan` returns **zero critical findings**;
`supabase--linter` returns no error-level security issue. The only remaining item is the
previously accepted warning `SUPA_authenticated_security_definer_function_executable`
(elevated routines are granted to `authenticated`/`service_role`, never `anon` or
`PUBLIC`). The earlier publish refusal reflected a stale scan, not a live exposure.

**Files added.**
- `src/lib/finance-lifecycle.ts` — canonical TypeScript mirror of the posting lifecycle:
  11 source types, their eligible operational states, their explicitly ineligible
  draft/open/forecast/request states, posting types, idempotency- and reversal-key
  construction, and a journal balance check.
- `src/lib/__tests__/fixtures/finance-posting.sql` — the deployed definitions of
  `neo_finance_post_txn`, `neo_finance_eligible_sources`, `neo_gl_post` and
  `neo_finance_reverse_posting`, exported from the live database so the tests assert
  against production SQL and fail on drift.
- `src/lib/__tests__/finance-lifecycle.test.ts` — 23 tests.

**Files changed.**
- `src/components/common/FactSection.tsx` — `SHARED_FACT_PATHS` extended to the full
  reconciliation set: net recognised revenue, POS open value, POS finalised sales,
  delivery sales, event confirmed forecast, collections, receivables, payables,
  occupancy rate, occupied room nights and available room nights. Dashboard, `/analytics`
  and `/finance` all render this one list from `useFacts` with the shared query key
  `["neo-facts", branchId, from, to]`, so the three surfaces are identical by
  construction for the same period.

**Automated coverage.**
1. Lifecycle eligibility per source: POS orders, folio charges, folio payments/receipts,
   event deposits, event invoices, event earned, event cancellation, delivery, laundry,
   supplier invoices, supplier payments — each proven both eligible in its posting state
   and ineligible in every draft/open/served/forecast/request state.
2. Source-type coverage is derived from the deployed SQL, so a new dispatcher branch
   without a declared rule fails the suite.
3. Idempotency: single key `source:id:posting_type`; replay returns the existing journal
   with `duplicate_prevented`.
4. Reversal: linked via `reversed_by_journal_id`, key `…:posting:reversal`, mirrored
   lines, `no_original_posting` and `already_reversed` guards; original + reversal nets
   to zero.
5. Balance: unbalanced or empty journals are refused (`journal is not balanced`,
   `nothing_to_post`).
6. Scoping: organisation, property, `neo_fact_timezone`, `neo_fact_currency`,
   `pg_advisory_xact_lock`, and capability denial via `insufficient_privilege` /
   `has_permission('finance','edit')`.
7. Evidence: every posting writes a posting receipt and emits `finance.posted`.
8. Callability: only `neo_finance_post_source` and `neo_finance_backfill` are in the
   client RPC manifest; the dispatcher and reversal writer are not browser-callable.
9. Loading/error/empty: `FactCard` renders a skeleton while loading, "Could not be
   calculated" on error, "Not authorised" when unpermitted, and an em dash for unknown
   values — a zero is only ever printed for a genuine zero, with its eligibility rule.

**Result.** Full suite: **297 passed / 0 failed (20 files)**.

**Remaining limitations (explicit).**
- The lifecycle tests assert the deployed SQL text and the deterministic TypeScript
  mirror; they do not execute a signed-in live posting. No live posting replay was
  executed in this pass and no operational revenue was created or mutated.
- The SQL fixture must be re-exported whenever the posting functions change; the
  source-type coverage test catches new branches, not silently altered account codes.
- Google Search Console verification is still outstanding.

---

## PMS availability search and available-room cards (2026-08-22)

**Files.**
- `supabase/migrations/*` — one migration consolidating `public.pms_available_rooms`.
- `src/lib/availability-search.ts` — the shared search contract now carries `roomId`.
- `src/lib/pms-data.ts` — `useAvailability` calls the single RPC contract (`_for_group`
  included) and `AvailableRoom` gains property, capacity, readiness, maintenance,
  occupancy, nights and qualification.
- `src/routes/_shell.pms.availability.tsx` — stable controlled draft, atomic commit to
  the URL, responsive available-room cards grouped by property, skeleton / error /
  empty states.
- `src/routes/_shell.pms.reservations.new.tsx` — pre-selects the room passed from a card.
- `src/lib/__tests__/pms-availability.test.ts` — 17 new tests.

**Migration.** The two overlapping `pms_available_rooms` overloads
(`(uuid,date,date,uuid,int,int)` and `(…,uuid)`) made PostgREST unable to choose a
candidate. Both were dropped and replaced by **one** SECURITY DEFINER function with the
seven-argument signature, `EXECUTE` revoked from `PUBLIC`/`anon` and granted to
`authenticated` only. It keeps organisation scoping through `current_org_id()`, keeps
the group-block exclusion (`_for_group`), uses `[arrival, departure)` overlap for stays,
assignments and holds, excludes out-of-order intervals, non-operational maintenance and
same-day arrivals into rooms that are not physically ready, and now also subtracts
**unassigned confirmed/guaranteed room-type demand** so a room type cannot be oversold.
`pg_proc` confirms a single remaining definition.

**Preserved data.** Function-only change: no table, reservation, room or room-block row
was created, altered or cancelled. Group-block behaviour was migrated, not removed.

**Tests.** Default arrival/departure + 1 night, URL round-trip, refresh/back/forward
reconstruction, invalid-range retention, room selection handoff, room type / party size
/ property filters, assigned overlap, adjacent same-day turnover, blocks, holds, group
inventory, unassigned room-type demand, out-of-order intervals, dirty same-day room,
future-date readiness, and card property labelling. Full suite: **314 passed / 0 failed
(21 files)**.

**Backend / RLS evidence.** Zawadi Springs Nairobi still shows 12 rooms: 103 dirty, 104
under maintenance, 108 out of service. The confirmed unassigned Family Room stay
`RES-2608-VGCI7` (2026-08-24 → 2026-08-28) now consumes one Family Room of inventory.

**Remaining limitation.** Verification was performed against the deployed SQL and the
deterministic TypeScript mirror of its rules; no signed-in browser session was driven
against the published site in this pass, and no reservation was created for testing.

### Live follow-up: the Search button dropped every search parameter (2026-08-22)

**Live failure.** After publishing, the direct URL
`/pms/availability?arrival=2026-08-24&departure=2026-08-25&roomType=all&adults=2&children=0`
rendered the six correct Zawadi cards and the Family Room reduction held, but typing
2026-08-25 → 2026-08-26 into the visible fields and pressing **Search** navigated to a
bare `/pms/availability`, losing every parameter and falling back to the default dates.
The controlled inputs held the typed values, so the fault was the submit-to-navigation
integration: an unscoped `useNavigate()` targeting the pathname, which discarded the
route search instead of updating it.

**Fix.** The page moved to `src/components/pms/AvailabilitySearchPage.tsx` and now binds
to its own route through `getRouteApi("/_shell/pms/availability")`:
`routeApi.useSearch()` for reading and `routeApi.useNavigate()` with a typed
`search: (prev) => ({ ...prev, ...submitted })` updater for writing. The submit stays on
the route, commits the exact draft atomically, keeps `roomType`, `adults` and `children`,
and pushes a history entry so back/forward and refresh reconstruct the committed search.
`src/routes/_shell.pms.availability.tsx` is now a thin route wrapper. No reload
workaround, no RPC or card-logic change, no reservation touched.

**Test.** `src/lib/__tests__/availability-router.test.tsx` mounts a real router whose
route id matches the application route, types new dates into the actual fields, clicks
the real Search button, and asserts the router location search/href, the re-rendered
result description and the arguments the availability query hook received — plus
filter preservation, back/forward and invalid-input retention. Full suite:
**318 passed / 0 failed (22 files)**.

### Live follow-up 2: Search submit had no effect in production (2026-08-22)

**Live contradiction.** At
`/pms/availability?arrival=2026-08-24&departure=2026-08-25&roomType=all&adults=2&children=0`
the fields accepted 2026-08-25 / 2026-08-26, but clicking the enabled `type=submit`
Search button (and pressing Enter) left the URL and the "Available rooms" heading on
2026-08-24 → 2026-08-25 while the inputs kept showing 25/26. The route-bound navigate
integration test passed because it exercises the React submit handler in a healthy tree;
a date input changes its displayed value natively even when no React listener is
attached, so "inputs update" was never evidence that the handler ran. Browser evidence on
the running app shows React hydration mismatches are occurring in this application
("Hydration failed because the server rendered HTML didn't match the client"), which is
exactly the condition where a submit listener is not attached yet and the click is lost.

**Resolution.** The search form no longer depends on JavaScript to carry the operator's
input to the route:
- `src/components/pms/AvailabilitySearchPage.tsx` — the form is now a real
  `method="get" action="/pms/availability"` form; `arrival`, `departure`, `adults` and
  `children` carry `name` attributes and the shadcn Select is mirrored by a hidden
  `name="roomType"` input. The React `onSubmit` still intercepts and performs the typed,
  route-scoped `navigate({ search: prev => ({...prev, ...submitted}) })`; it calls
  `preventDefault()` only when it actually handled the submit. If the navigation throws,
  the browser's plain GET submit proceeds and produces the identical URL. Validation
  still short-circuits without discarding the draft.
- `src/routes/_shell.pms.availability.tsx` — unchanged thin wrapper; the canonical RPC,
  card rendering and fact/source-of-truth work were not touched.

**Tests.** `src/lib/__tests__/availability-router.test.tsx` (7 tests) now also asserts the
production composition: the route file's `validateSearch` identity and route id, the
form's `method`/`action`, absence of any nested `form`, the submit button's `type`, the
exact `FormData` query the browser would send after retyping a date, and a
`form.requestSubmit()` (Enter-key path) commit that moves both the router location and the
rendered heading. Full suite: **321 passed / 0 failed**.

**Live verification limitation.** No authenticated browser session is available to the
agent for this project right now (`signed_out`), so the authenticated
`/pms/availability` page could not be driven end-to-end from here; the unauthenticated
request correctly redirects to `/auth`. This entry is therefore not claimed as
live-verified — it must be confirmed on the published site by signing in, retyping
2026-08-25 → 2026-08-26 and checking the URL and heading both move.

### Live follow-up 3: valid submit was still swallowed by preventDefault (2026-08-22)

**Live contradiction.** The deployed bundle from `75baec9` correctly carried
`method="get"`, `action="/pms/availability"` and named controls, yet retyping
2026-08-25 / 2026-08-26 and pressing **Search** still left the URL and the "Available
rooms" heading on 2026-08-24 → 2026-08-25. Root cause: `runSearch()` returned `true` for
every valid draft, so `onSubmit` always called `preventDefault()`; the route-scoped
`navigate(...)` then did nothing observable and never threw, so the claimed native-GET
fallback could not run. The previous integration test hid this because it asserted the
router location that the same intercepting handler produced.

**Resolution — native GET is the contract for valid submissions.**
- `src/components/pms/AvailabilitySearchPage.tsx` — `runSearch()` is replaced by
  `draftIsInvalid()`. React now intercepts **only** invalid drafts: `preventDefault()`,
  error shown, visible values retained. A valid draft clears the error and is left to the
  browser: no `preventDefault()`, no TanStack navigation. The named controls
  (`arrival`, `departure`, `adults`, `children`, plus the hidden `roomType` mirroring the
  Select, which submits `all` for "Any type") serialise the exact current draft, and the
  route's typed `validateSearch` reconstructs the controlled state, heading and query on
  the loaded page. The `routeApi.useNavigate()` binding was removed; `routeApi.useSearch()`
  remains the single read source.
- The availability RPC, query hook, room cards and fact/source-of-truth work were not
  touched.

**Tests.** `src/lib/__tests__/availability-router.test.tsx` (7 tests) now proves the
submit contract instead of the interception: a cancelable bubbling `submit` on the
production component is **not** default-prevented for a valid draft and its `FormData`
yields exactly `arrival=2026-08-25`, `departure=2026-08-26`, `roomType=all`, `adults=2`,
`children=0`; filters survive; the form is a plain GET form with no nested form and a real
submit button; loaded search params reconstruct draft, heading and query arguments;
location changes (reload/back/forward) rebuild state; the route file's `validateSearch`
identity and route id match; and an invalid departure is prevented with the typed value
and error retained.

**Live verification limitation.** No authenticated browser session is available to the
agent (`signed_out`), so the authenticated page was not driven end-to-end from here. The
change removes the client-side interception entirely for valid submits, so the URL move
is now performed by the browser itself rather than by application JavaScript.

## Availability — Live follow-up 4: bare-URL default dates (commit 6270800 continuation)

**Live contradiction (production, one authenticated session):**
- `/pms/availability` (no query params) rendered Arrival `2026-08-22`, Departure `2026-08-22`, "0 nights", a validation error and zero room cards.
- `/pms/availability?arrival=2026-08-24&departure=2026-08-25&roomType=all&adults=2&children=0` rendered 1 night and 6 real room cards.

Not cache, auth, permissions or the RPC — the defect was entirely in the default/parser path.

**Root cause:** `addDays()` in `src/lib/pms.ts` parsed the ISO date at *local* midnight and then re-serialised with `toISOString()`. For a UTC+3 property (Africa/Nairobi) `2026-08-22T00:00+03:00` is `2026-08-21T21:00Z`; adding one day gives `2026-08-22T21:00Z`, whose ISO date slice is **the same calendar day**. So the bare-URL default produced `arrival === departure`, i.e. zero nights, and the query was disabled.

**Resolution** (`src/lib/availability-search.ts`, `src/components/pms/AvailabilitySearchPage.tsx`):
- Added the canonical default contract `resolveAvailabilitySearch()` plus timezone-free helpers `propertyToday()` (Intl `en-CA` in `Africa/Nairobi`), `addCalendarDays()` and `calendarNights()` (pure `Date.UTC` arithmetic — no drift, correct across month/year/leap rollover).
- Bare URL → arrival = property-local today, departure = arrival + 1 calendar day; arrival-only or blank/unparsable departure → arrival + 1; explicit valid departure preserved byte-for-byte.
- Present-but-invalid ranges (same-day/backward) are distinguished from absent params via `explicitInvalidRange` and are never silently repaired — the operator's input and the validation message stay visible.
- Defaults `roomType=all`, `adults=2`, `children=0`.
- A partial/bare URL is canonicalized once with `navigate({ replace: true })`; because the guard is the presence of the params themselves, the post-replace URL needs no canonicalization and cannot loop. Reload/back/forward stay stable.
- First render now commits a valid one-night range, so the availability query is enabled immediately and returns cards; the zero-night empty state can no longer appear on first open.

**Tests:** `src/lib/__tests__/availability-defaults.test.ts` — UTC+3 no-drift, month/year/leap rollover, bare URL, arrival-only, blank/invalid departure, explicit valid range, explicit same-day and backward retention, canonicalization idempotency (no loop), and the first committed query inputs. Full suite: 329 passed / 23 files.

## Kitchen unification — POS KDS and Kitchen Live Queue on one canonical source

**Defect (live):** `/pos/kds` listed real tickets (T-MSZS25OJ, T-MSZUCYWE, T-MT4G86RI …) while
`/kitchen/queue` showed zero cards for the same Owner session and scope. Cause was two divergent read
paths (`useStationTickets` in `src/lib/pos-data.ts` vs `useKitchenQueue` in `src/lib/kitchen-data.ts`)
with different selects, status filters and branch scoping, plus per-page hardcoded actions.

**Backend (migration):**
- `public.neo_kitchen_queue(_branch, _station, _view)` — SECURITY INVOKER (RLS applies), single read of
  `station_tickets` + items + order/table/station context, age/delay derivation and a
  `station_missing` configuration exception flag. Views: `live`, `all`, `delayed`,
  `unassigned-station`, or an explicit status.
- `public.neo_kitchen_ticket_transition(_ticket, _to, _reason)` — one transactional state machine
  (`new → accepted → preparing → (partially-ready) → ready → served → completed`, `cancelled` only from
  pre-ready states and only with a reason). Rejects skipped, backward and terminal-state moves; walks
  each item through `kitchen_item_transition`, which keeps capability + station-scope checks, POS item
  sync and audit rows in `station_ticket_status_history`.
- `public.neo_kitchen_ticket_delay(_ticket, _reason)` — delay recorded as metadata + audit row +
  `kitchen.ticket.delayed` domain event; it is not a lifecycle state.
- `kitchen_item_transition` hardened: the waiter "order ready" notification is now emitted at most once
  per ticket (idempotent insert guard) alongside the already-idempotent domain event key.
- `public.neo_kitchen_backfill_tickets(_branch)` — idempotent reconciliation that routes any open POS
  items lacking ticket items. EXECUTE revoked from PUBLIC and granted to `authenticated` on all four.

**Frontend:**
- New `src/lib/kitchen-tickets.ts`: shared types, canonical status normalisation, `TICKET_TRANSITIONS`,
  `ticketActions()`, `useKitchenTickets`, `useKitchenTicketTransition`, `useKitchenTicketDelay`,
  `useKitchenTicketBackfill`, `useKitchenTicketRealtime` and `useScopedStations` (station-scoped users
  get no "All stations" option).
- New `src/components/kitchen/TicketCard.tsx`: one presentation of ticket id, items, quantities, notes,
  modifiers, allergies, order/table reference, station, timer, priority and lifecycle actions.
- `src/routes/_shell.pos.kds.tsx` and `src/routes/_shell.kitchen.queue.tsx` rewritten onto it; both share
  the `["kitchen","tickets"]` query key, so a transition on either page refreshes both. Loading and error
  states are explicit; empty renders only after a successful zero-row load.
- `src/lib/rpc-manifest.ts` updated with the four routines.

**Evidence (read-only production):** `station_tickets` → 4 `new` + 4 `ready` open tickets, 0 tickets
without a station, 0 sent POS items lacking a ticket item, so both pages now resolve the identical
8-ticket set. Tests: `src/lib/__tests__/kitchen-ticket-contract.test.ts` (source unification, no direct
`station_tickets` reads, manifest registration, legal/illegal transitions, terminal states, cancellation
reason, delay-as-metadata, legacy status normalisation, scope-limited station selector, truthful
loading/empty, shared invalidation key). Full suite: 344/344 passing.

**Remaining limitation:** transition and RLS behaviour is proven by the server contract and the unit
suite; a signed-in end-to-end mutation was not executed because that would alter real operational ticket
statuses.

### Kitchen lifecycle reconciliation (follow-up to 9e0db7d)

**Defect:** the shared card exposed that four legacy tickets carried header `ready` while every
`station_ticket_item` was still `new`, and `/kitchen/queue` still wrote item state through the legacy
`useItemTransition` hook — two lifecycle write contracts.

**Model repair (migration):**
- `public.neo_kitchen_aggregate_ticket(_ticket)` — the only writer of the ticket header. Rules: all items
  new → `new`; accepted mix without preparation → `accepted`; any preparing and none ready → `preparing`;
  ready mixed with earlier open states → `partially-ready`; all ready → `ready`; all served → `served`;
  all completed → `completed`; no active items → `cancelled`. Timestamps are re-derived, and the waiter
  "ready" notification/domain event stays exactly once per ticket.
- `public.neo_kitchen_item_transition(_item, _to, _reason)` — canonical item write path: capability check,
  station-scope check, allowed-transition map, terminal-state rejection, quality-hold guard, audit row in
  `station_ticket_status_history`, `pos_order_items` sync, then aggregation in the same transaction.
- `public.kitchen_item_transition` now simply delegates to it, so no legacy caller can bypass
  aggregation, audit or scope.
- `public.neo_kitchen_ticket_transition` now advances every non-terminal item along the same state
  machine and re-aggregates; if the items cannot resolve to the requested header it raises and rolls back.
  A ticket can no longer be `ready` with `new` items.
- `public.neo_kitchen_invariant_violations()` — read-only checker listing any header that disagrees with
  its items. EXECUTE revoked from PUBLIC and `anon` on all kitchen routines (the anon linter findings
  introduced by the previous migration are cleared).

**Legacy reconciliation (four tickets only).** Evidence: each of T-MSZS25OJ, T-MSZSA9X5, T-MSZUCYWE,
T-MSZUCZE2 had `accepted_at`/`started_at`/`ready_at` recorded on the ticket, zero rows in
`station_ticket_status_history`, and `pos_order_items` already at `served` (first two) or `ready` (last
two). The legacy KDS path therefore advanced the ticket and the POS order item but never the production
item, so the downstream POS state is the authoritative witness of how far production got. Each `new` item
on those four tickets was aligned to its own downstream POS state (`served`/`ready`), given an attributable
`station_ticket_status_history` row explaining the reconciliation, and each ticket re-aggregated:
T-MSZS25OJ and T-MSZSA9X5 resolve to `served` (leaving the live view, retained in history), T-MSZUCYWE and
T-MSZUCZE2 to `ready`. No other ticket or history row was touched.

**Frontend:** `src/lib/kitchen-tickets.ts` now exports the item half of the contract
(`ITEM_TRANSITIONS`, `ITEM_ACTION_LABELS`, `itemActions`, `isTerminalItem`, `deriveTicketStatus`) plus
`useKitchenItemTransition`. `/kitchen/queue` uses it instead of `useItemTransition`/`ITEM_TRANSITIONS`
from `kitchen-data`; POS KDS omits item-granular controls only — ticket status, item statuses and
ticket-level actions are the identical shared contract on both pages.

**Verification:** `neo_kitchen_invariant_violations()` returns zero rows; all eight tickets now show
header and items in agreement (`new/new` ×4, `ready/ready` ×2, `served/served` ×2), with
`pos_order_items` matching. Tests: `src/lib/__tests__/kitchen-ticket-contract.test.ts` extended to 26
cases covering the impossible Ready/New invariant, aggregation of every mix, partially-ready, illegal /
backward / terminal item moves, reason requirements, canonical-RPC usage on both pages and manifest
registration. Full suite: 355/355 passing.

**Remaining limitation:** transition rejection paths are proven by the server contract and the unit
suite; no signed-in end-to-end mutation was executed against live tickets, as the RPCs resolve
organisation, capability and station scope from the caller's session.

## Kitchen — production-station routing, one-station ticket invariant (2026-08-22)

**Migration**: `kitchen_station_routing_partition` (applied 2026-08-22, description "Kitchen production-station routing").

**Functions**
- `public.neo_station_is_usable(_org,_branch,_station)` — org/branch/active station guard.
- `public.neo_kitchen_resolve_station(_org,_branch,_menu_item,_category,_order_type,_persisted) -> jsonb {station_id, source, missing}` — the single deterministic resolver. Precedence: item routing rule → category routing rule → persisted `pos_order_items.station_id` → `menu_items.station_id` → `menu_categories.station_id` → typed `missing-routing`. No arbitrary/sole-station guess remains.
- `public.neo_kitchen_route_order_item(_order_item)` — resolver applied to a persisted POS line.
- `public.kitchen_resolve_station` and `public.neo_resolve_item_station` rewritten as thin delegates, so POS send-to-kitchen (`kitchen_route_order`), the `neo_pos_item_station` trigger, `neo_kitchen_backfill_tickets` and replay all share one contract.
- `public.neo_kitchen_reconcile_stations(_org,_branch)` — transactional, idempotent partitioning. Single-station null tickets get their station; mixed tickets keep the original identity for the deterministic primary partition (most items, then lowest station id) and move only `station_ticket_items` links into existing or system-generated partition tickets (`<parent>-<md5(station)[0:4]>`). Statuses, timestamps, chef attribution, delay reason, priority reason, created_by and routing notes are preserved; each partition is re-aggregated inline so no ready notification, domain event, finance posting or audit event is re-emitted for historical state. Cross-org calls rejected; anon/PUBLIC EXECUTE revoked.
- `public.neo_kitchen_invariant_violations()` extended: `status-aggregation`, `ticket-station-null`, `ticket-station-mixed`, `item-station-null`, `ticket-item-station-mismatch`.

**Preserved production data** (Zawadi Springs): 38 ticket-item links before and after, 38 distinct order items, zero deletions.
- T-MSZS25OJ → Hot Kitchen (2 items, served)
- T-MSZSA9X5 → retained as Pastry (1 item); its 14 Hot Kitchen items merged into the pre-existing Hot Kitchen ticket for the same order/course (T-MT46O1IL), no duplicate ticket created
- T-MSZUCYWE → Hot Kitchen (6, ready) + new partition T-MSZUCYWE-5ECF → Pastry (3, ready)
- T-MSZUCZE2 → Pastry (1, served)
Second run returned `{tickets_assigned:0, partitions_created:0, items_moved:0, items_without_routing:0}` — idempotent. Post-run invariant query returns 0 rows (no null, mixed or mismatched ticket stations).

**Frontend**
- `src/lib/kitchen-tickets.ts`: `STATION_ROUTING_PRECEDENCE`, `ticketRoutingException()`, `ROUTING_EXCEPTION_MESSAGE`, `useKitchenStationReconcile()`.
- `src/components/kitchen/TicketCard.tsx` / `TicketAuditSheet.tsx`: the generic "Station not configured" fallback is gone; both pages show the canonical `neo_kitchen_queue` station and raise the typed configuration exception only when routing is genuinely unresolved.
- `src/routes/_shell.kitchen.operations.tsx`: "Reconcile ticket stations" action.
- `src/lib/rpc-manifest.ts`: `neo_kitchen_reconcile_stations` registered as authenticated-only.

**Tests** — `src/lib/__tests__/kitchen-station-routing.test.ts` (16) against the deployed SQL fixture `fixtures/kitchen-routing.sql`, plus routing cases in `kitchen-ticket-contract.test.ts`. Coverage: rule precedence and item-before-category, org/branch/active scope, typed missing-routing, one resolver across all entry points, order/station/course ticket keying (mixed-order split), deterministic primary partition, link-move-only with no order-item duplication or deletes, preserved history columns, no re-emitted notifications/events, idempotent re-entry predicate, cross-org rejection, invariant coverage, invoker-side RLS, exception surface, manifest grant. Full suite: **377 passed (25 files)**.

**Remaining limitation** — final live browser reconciliation of `/pos/kds` and `/kitchen/queue` was verified from the read-only production tables (5 open tickets, all with a resolved station), not through an interactive authenticated session; no live ticket status was mutated to prove the UI.

## POS settlement + menu catalogue — independent audit corrections (2026-08-23)

**Migrations applied** (in order):
1. `pos_settlement_menu_audit_repair` — the corrective migration; deployed SQL is checked in as the test fixture `src/lib/__tests__/fixtures/pos-settlement-menu.sql`.
2. `pos_settlement_gl_code` — settlement GL account helper.
3. `pos_settlement_confirmed_status_gl` — adds `confirmed` to the settlement-status filter inside `neo_finance_post_txn` so a confirmed card/transfer/M-Pesa bill is no longer booked to the cash account.

**Authorization / scoping**
- Canonical three-part capability `pos.payments.manual-confirm` replaces the legacy dotted row; `pos_record_payment_attempt` and `pos_confirm_manual_payment` call `has_permission('pos','payments','manual-confirm')`. The dotted spelling still resolves in the UI through `canonicalPermission`.
- New canonical `pos.menu.assign-station`; `neo_menu_assign_station` requires it, and the Menu Management control is gated on it instead of broad `menu.manage`.
- Manual confirmation template grants: Owner, IT/System Administrator, General Manager, Operations Manager. The Food and Beverage Manager template grant was removed (no explicit custom grant existed); General Manager added.
- `public.neo_branch_in_scope(_branch)` enforces property scope in every settlement and assignment RPC alongside organisation scope. `organisation` access scope stays valid; `technical` scope mutates nothing.
- `pos_reconcile_settlement_internal` is the engine used by triggers and by the UI-facing `pos_reconcile_order_settlement`; EXECUTE is revoked from PUBLIC/anon/authenticated and granted only to `service_role`. No SECURITY DEFINER mutation is reachable without both capability and property checks.

**Settlement correctness**
- Ceiling: balance minus confirmed payments minus *active* `initiated`/`pending` attempts. Same idempotency key returns the original attempt with `duplicate: true`.
- External methods (M-Pesa, card, transfer, wallet) require a provider/external reference; manual confirmation requires that reference **and** a non-empty verification note.
- M-Pesa remains unconfigured: external attempts are written `pending`. The two existing pending M-Pesa rows are untouched and are not reinterpreted as paid.
- Confirmed payment recomputes totals; the item trigger `tg_pos_item_terminal_settlement` reconciles when the last production item becomes terminal, closing a fully paid order. The trigger writes only to the order (no recursion) and emits no finance/outbox/audit event of its own.
- Finance handoff remains **derived** from the existing `pos_orders_autopost_txn` trigger into `finance_posting_receipts`; no second posting path was introduced. Exactly-once continues to rest on that trigger's receipt key.
- Cash still passes through the existing open-cashier-shift control trigger.
- UI action relabelled "Reconcile & close if eligible".

**Menu surface / provenance**
- `neo_menu_catalogue(_branch, _include_drafts)` returns `imported`, `import_file_name`, `import_batch_id`, `import_batch_status`, plus effective `station_id`/`station_name`/`station_source`/`station_missing`, strictly org- and property-scoped. Drafts only when explicitly requested.
- Menu Management shows the Imported badge with source file and batch status, published/draft/imported/unrouted counts, and menu, category, station, publish and origin filters.
- The POS ordering terminal consumes the published-only catalogue; management uses the same RPC with drafts included.
- Mawimbi: 77 published current rows, 56 Hot Kitchen / 21 Pastry, zero routing exceptions. Historical import rows preserved; batch `0d13…` remains superseded.

**Evidence** — `src/lib/__tests__/pos-settlement-audit.test.ts` (17) and `src/lib/__tests__/menu-catalogue-audit.test.ts` (12) assert against the deployed SQL fixture and the shipped UI. Full suite: **406 passed (27 files)**.

**Remaining limitation** — all assertions are contract-level against deployed SQL and source; no signed-in end-to-end payment was executed against live orders, and no live order state was mutated.

---

## Events property assignment & module completion (this entry)

**Defect** — every event record for Zawadi Springs carried `branch_id = NULL`. Events RLS was organisation-only, `useEventsCtx` read the signing-in user's `profile.branch_id` (null for organisation-wide accounts), and twelve Events tabs were still `ModulePlaceholder` screens.

**Migrations applied** (in order):
1. `events_property_assignment_repair` — backfill, guards, property-scoped RLS, canonical capabilities.
2. `events_workspace_services` — the authoritative workspace reader and the guarded create/transfer/convert/report routines.

**Data repair** — production holds exactly two Zawadi Springs event bookings (EVT-3001 and EVT-3002); the figure of eight is the global count across four organisations and was previously misstated here. Both, plus venues, enquiries, quotations, site visits, equipment and venue holds, were assigned to the Nairobi property. Dependent rows (billing lines, department requirements, banquet orders, feedback) inherited the parent event's property. Nothing was deleted, duplicated or renumbered; every reference, amount, status and date is unchanged, and each event carries an `events.booking.property-backfill` activity entry — two backfill activity rows, no duplicates. Preserved values: **EVT-3001** total 1,071,840, paid 535,920, confirmed, 2026-09-07; **EVT-3002** total 1,633,280, paid 0, provisional hold, 2026-10-01. Verified: `event_bookings/enquiries/quotations/venues` with a null property = 0; child rows disagreeing with their event's property = 0.

**Structural guarantees**
- `neo_event_booking_guard()` rejects an event with no property, a property outside the organisation, and a venue from another property; a property change through an ordinary UPDATE is refused and only `neo_event_booking_transfer` may move an event.
- `neo_event_child_branch_inherit()` on `event_billing_items`, `event_department_requirements`, `banquet_event_orders`, `event_feedback` and `venue_blocks` fills the property from the parent event and rejects a mismatch.
- RLS on `event_bookings`, `event_enquiries`, `event_quotations`, `event_venues`, `site_visits`, `venue_blocks`, `event_resources` is now `organisation AND neo_branch_in_scope(branch_id)`; the four child tables scope through their event. Customer-facing read policies were left untouched. `event_types` and organisation-wide configuration stay organisation-scoped by design.

**Authoritative services** (all `has_permission` checked, EXECUTE revoked from PUBLIC/anon)
- `neo_event_workspace(_branch, _from, _to)` — one scoped read model behind the dashboard, calendar, bookings, readiness, billing and reports, including readiness, billing, resource and feedback roll-ups.
- `neo_event_booking_create(_payload)` — requires a chosen property, validates venue/quotation/enquiry property, allocates the reference through `next_document_number`, and is idempotent through `event_booking_idempotency`.
- `neo_event_booking_transfer(_booking, _branch, _reason)` — moves the event and every dependent record together, reason mandatory, logged.
- `neo_event_convert_enquiry` / `neo_event_convert_quotation` — one event per source record, repeat calls return the same event; a quotation must be accepted/approved.
- `neo_event_reports(_branch, _from, _to)` — pipeline, conversion, revenue, status/venue breakdown and readiness.

**Capabilities** — added `events.bookings.confirm`, `events.bookings.transfer`, `events.enquiries.convert`, `events.quotations.convert`, and `events.packages|feedback|reports|settings.*`, each granted to the roles already holding the closest sibling capability. Events tabs and route guards now read `events.<feature>.<action>` from the capability registry.

**Screens** — Enquiries, Calendar, Site Visits, Quotations, Readiness, Venues, Packages, Equipment, Billing, Feedback, Reports and Settings replaced their placeholders with live, property-scoped operational views. Bookings creates through the RPC and offers a permission-gated property transfer. Where a property is not selected, screens show "Choose a property first" instead of silently writing an orphan record.

**Evidence** — `src/lib/__tests__/events-property-contract.test.ts` (6) plus manifest coverage. Full suite: **412 passed (28 files)**.

**Remaining limitation** — verification is contract-level against deployed SQL, live table state and source; no signed-in end-to-end event creation or transfer was executed in the browser.

## Menu import provenance, conversion links & settlement concurrency evidence (this entry)

**Menu import inspector** — `public.neo_menu_import_batches(_branch)` is the single scoped reader of import history: per batch it returns supersession (`superseded`, `superseded_by`, `supersedes`), live versus preserved historical rows, published/draft counts, unrouted count, and station/routing-source distributions. It is `has_permission('pos','menu','view')` checked, property scoped, and EXECUTE is revoked from PUBLIC/anon. `/admin/menu-imports` renders it (batch id, file, property, menu, status, row outcome, station and routing-source summaries) and is reachable from Menu Management → "Import history". Verified in a signed-in browser session: a user without `pos.menu.view` receives the RPC refusal *and* the unified access-denied panel — no partial data leak.

**Menu Management provenance** — item rows now show the short batch id alongside file name and batch status, and the catalogue can be filtered by routing source (item/category rule, item/category default, unrouted) and by import batch, including "created here (no batch)".

**Conversion links** — `useConversionLinks()` reads the event already linked to each enquiry and quotation. Both screens now show the linked event reference, its status and a link to it, and withdraw the convert control with an explicit "converted once already — a second conversion is refused" note, matching the database rule where a repeat call returns the same event rather than creating another.

**Settlement concurrency evidence** — `src/lib/__tests__/pos-settlement-concurrency.test.ts` pins the three deployed mechanisms that make a replayed payment safe: the partial unique index on `(organization_id, idempotency_key)`, the `FOR UPDATE` order lock taken *before* the ceiling is computed, and the ceiling that subtracts other active `initiated`/`pending` attempts from the outstanding balance. It also asserts the attempt path posts nothing to finance, so a replay cannot double-post. The deployed index DDL was added to the SQL fixture so the assertions fail if deployment drifts.

**Remaining limitation** — the browser session available for verification lacks `pos.menu.view` and POS payment capabilities, so card/transfer/manual-confirm, M-Pesa pending and cashier-shift gating remain verified at contract level against deployed SQL rather than by an end-to-end signed-in checkout.


## Events corrective contract — idempotency, dependency scope, feature authorisation (this entry)

**Correction of record** — production holds **exactly two Zawadi Springs event bookings**, EVT-3001 and EVT-3002. The earlier "8 Zawadi events" claim was the global count across four organisations. Preserved, unchanged: EVT-3001 total 1,071,840, paid 535,920, confirmed, 2026-09-07; EVT-3002 total 1,633,280, paid 0, provisional hold, 2026-10-01. Two backfill activity rows, no duplicates.

**Migration applied** — `supabase/migrations/20260822175746_ab425416-5691-4091-ad3c-49a160c30227.sql` (events corrective contract).

**Idempotency and numbering**
- `event_booking_idempotency` now has PRIMARY KEY `(organization_id, key)`; existing rows preserved, so identical keys in different tenants can no longer collide.
- The UI generates one stable idempotency key per submission (`eventIdempotencyKey`), reused on retry and double click; conversions key on the source enquiry/quotation.
- `neo_event_booking_create` refuses any client-supplied `event_reference` and always allocates through the branch-aware `next_document_number('event_booking','EVT',branch)`. Unique index `event_bookings_org_branch_reference_key` on `(organization_id, branch_id, event_reference)`.
- Creation validates name, date, start/end (start < end), an active in-scope property, and that event type, customer, corporate account and coordinator belong to the organisation with venue/quotation/enquiry on the same property.

**Dependency property enforcement** — inheritance and mismatch rejection now cover `event_room_blocks`, `event_resource_reservations` (through booking, or through the resource when the booking is null), `event_requirements`, `event_menus` and `event_menu_items`, `event_milestones`, `event_vendors`, `event_change_requests`, `event_guest_counts`, `event_documents` and `event_activity_logs` (booking or enquiry), `event_quotation_items`, `event_package_items`, with `venue_blocks` retained. `event_packages` is property scoped. `event_types` stays organisation-wide.

**Feature-level backend authorisation** — every events table's SELECT/INSERT/UPDATE policy now carries its canonical `has_permission('events', <feature>, <action>)` alongside org + property scope, so branch access alone can no longer create venues, packages, resources or enquiries through a direct data call. `neo_event_workspace` requires `events.bookings.view` and redacts financial, readiness, resource and feedback rollups unless the caller holds the matching view permission; `neo_event_billing` is a thin `events.billing.view` projection over the same `event_bookings` source, which remains the one canonical event entity.

**Transfer** — moves billing lines, department requirements, banquet orders, feedback, venue blocks and room blocks, releases incompatible venue holds, resource reservations and room allocations, and records every release in the event activity log.

**Evidence** — `src/lib/__tests__/events-contract-verification.test.ts` against `src/lib/__tests__/fixtures/events-contract.sql`, dumped from the deployed database (function definitions, policies, constraints, triggers).

**Remaining limitation** — not yet deployed; verification is contract-level against deployed SQL and live table state, with no signed-in end-to-end creation or transfer executed in the browser.

## Events corrective contract, second pass — submission tokens, create serialisation, cross-property trace (this entry)

**Migration applied** — `supabase/migrations/20260822180957_73e775d9-b64f-4841-98a7-d4d4a12620b3.sql`. The earlier migration `20260822175746_ab425416-5691-4091-ad3c-49a160c30227.sql` is left untouched.

**True per-submission idempotency** — the content hash `eventIdempotencyKey` is withdrawn: two legitimately distinct events with identical details would have collapsed into one. The New Event form now holds one token per form attempt (`useEventAttemptKey`, a fresh `crypto.randomUUID()`), sends it on every retry and double click of that attempt, and rotates it only after a confirmed creation or when the operator deliberately opens the form again. Conversions stay source-keyed (`eventSourceKey('enquiry'|'quotation', id)`) because each source converts exactly once; `neo_event_convert_enquiry` and `neo_event_convert_quotation` now allocate that key server-side. `neo_event_booking_create` rejects a blank or missing `idempotency_key` for client creation.

**Concurrency-safe create** — the select-then-insert window is closed. `neo_event_booking_create` takes a transaction-scoped `pg_advisory_xact_lock(hashtextextended('neo_event_booking_create:'||org||':'||key, 0))` *before* the existence check, so a simultaneous second call waits, re-checks, and returns the first call's booking rather than creating a second one. If the key race is still lost at insert time, the function returns the winning booking and leaves no orphan row.

**Cross-property trace** — `neo_event_trace_guard` previously compared organisation only. It now loads both the booking and the enquiry branch and rejects a trace row that links records at different properties.

**Transfer reference collision** — the `(organization_id, branch_id, event_reference)` unique index could block a transfer whose reference already exists at the destination. `neo_event_booking_transfer` now detects the collision, allocates a new branch-aware reference through `next_document_number('event_booking','EVT',_branch)`, and returns `event_reference`, `old_reference`, `new_reference` and `reference_reallocated`, with both references retained in the transfer activity detail. Where there is no collision the reference is preserved. The transfer toast states which happened.

**Evidence** — `src/lib/__tests__/events-contract-verification.test.ts` extended with the required-token, per-attempt-rotation, lock-ordering (lock before existence check before insert), cross-property trace and reference-collision assertions, against the refreshed deployed fixture `src/lib/__tests__/fixtures/events-contract.sql`. Full suite: **489 passed (30 files)**, typecheck clean.

**Remaining limitation** — not deployed; verification remains contract-level against deployed SQL and live table state, with no signed-in end-to-end creation or transfer executed in the browser.

## Events transfer — future same-property invariant for sources, traces and documents (this entry)

**Migration applied** — `supabase/migrations/20260822181810_b28340a1-1b84-44a6-9ed5-8f8f1a44d683.sql`. The two earlier events migrations are left untouched.

**Defect** — `neo_event_booking_transfer` moved `branch_id` but left `event_bookings.enquiry_id` and `quotation_id` pointing at source records at the old property, and left existing `event_activity_logs` / `event_documents` rows carrying both `booking_id` and `enquiry_id`. Those rows became cross-property without their row triggers firing, contradicting `neo_event_trace_guard` and the same-property creation contract.

**Rule applied — data preserving, atomic, inside the one transfer statement block**
- Enquiries and quotations stay at their own property. No source record and no commercial data is re-branded or deleted.
- Where the linked enquiry or quotation sits at a property other than the destination, it is detached from the transferred booking (`enquiry_id` / `quotation_id` set to null on the booking only).
- `event_activity_logs` and `event_documents` tied to the transferred booking keep `booking_id`, so history and documents stay attached to the event; only an incompatible `enquiry_id` on those rows is cleared.
- The destination property must now be `active`; a transfer to a deactivated property raises `The destination property is not active.`

**Auditability** — `detached_enquiry_id`, `detached_quotation_id`, `traces_detached` and `documents_detached` are written into the immutable `events.booking.transferred` activity detail and returned in the RPC payload, alongside the existing reference, venue, resource and room-release fields.

**Live state re-queried after the migration** — booking↔enquiry property mismatches **0**, booking↔quotation mismatches **0**, activity-log trace mismatches **0**, document mismatches **0**. No historical rows required repair; the change governs future transfers.

**Evidence** — `src/lib/__tests__/events-contract-verification.test.ts` gains six assertions on the refreshed deployed fixture `src/lib/__tests__/fixtures/events-contract.sql`: active-destination refusal, detach-not-move/delete for both sources, conditional detachment only when the source property differs, history/documents retaining `booking_id` with only the enquiry link cleared, detachment ordering before the immutable log row, and every detachment field present in both the activity detail and the return payload. Full suite: **495 passed (30 files)**, typecheck clean.

**Remaining limitation** — not deployed; verification is contract-level against deployed SQL plus the live mismatch counts above, with no signed-in end-to-end transfer executed in the browser.

## New Reservation — Room & rate selection blocker (front office)

**Symptom (live, Savanna Crown Nairobi / Receptionist):** clicking a matching
Standard Double rate left the rate plan unselected, nightly rate KES 0 and
Continue disabled; the list also showed plans for every room type, and an
Availability room handoff did not preselect the room's room type.

**Repair (UI/state only — no engine, RLS or data change):**
- `src/components/pms/RatePlanPicker.tsx` (new): accessible radiogroup rate
  list plus `selectableRatePlans()` (active plans whose `room_type_id` matches
  the selected room type exactly — generic/null-room-type plans and other room
  types are never offered) and `roomTypeForRoom()`.
- `src/routes/_shell.pms.reservations.new.tsx`: rate plan chosen from the new
  list instead of the dropdown that never committed its value; room-type
  change clears rate/meal/override and an incompatible pre-assigned room; a
  handed-off `roomId` resolves and preselects its room type; loading/error
  states added for the rate-plan query.

**Preserved:** `pms_quote_rate` remains the only price source (no browser
calculation, no fallback insert path), `pms_available_rooms` unchanged,
property/tenant scoping unchanged via `useActivePropertyFilter`.

**Follow-up (diff review, same repair):** two state-contract defects closed —
`selectableRatePlans` no longer admits `room_type_id` NULL plans, and every
rate selection now sets the meal plan to `plan?.meal_plan_id ?? ""` so a
Room Only plan chosen after a Bed & Breakfast plan no longer leaves stale BB.

**Evidence:** `src/lib/__tests__/reservation-rate-selection.test.tsx` — 12
tests driving real click events (selection persists, meal plan inherited,
stale meal plan cleared when switching BB → Room Only, generic null-room-type
plan neither offered nor rendered, other room types unreachable, incompatible
plan cleared on room-type change, Room 113-style handoff). Focused run: 12
passed. Full suite: 2443 passed / 1 skipped (163 files). `tsgo --noEmit`:
clean.

**Limitations:** no authenticated browser verification (browser session is
signed out) and no live data was mutated; the exact reason the previous Radix
dropdown swallowed the selection was not isolated — it was replaced with a
deterministic list control. Not deployed.
