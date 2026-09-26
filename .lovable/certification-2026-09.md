# NEØ — onboarding, high-growth tables, tenancy: certification record

## 1. Onboarding engine — adapter matrix and volume

`src/lib/__tests__/onboarding-adapter-matrix.test.ts` builds a synthetic file
from each domain's own declared fields (no hotel data) and drives the shared
engine end to end.

| Adapters certified | 18 |
| --- | --- |
Assets & Equipment, Departments, Asset Categories, Room Types, Item Groups,
Stock Categories, Stores & Locations, Tax Codes, Meal Plans, People & HR,
Rooms, Suppliers, Inventory Items, Customers & Guests, Corporate Accounts,
Rates & Packages, Menu Items, Chart of Accounts.

Each adapter is asserted to: recognise its own file, account for every source
row exactly once (`plan.reconciled`), leave no required field silently blank,
have a destination write for every required field, and produce an honest
summary. Adapters that can generate an identifier are asserted to generate
none, and to block commit, while the identifier decision is undecided.

Volume: 10 / 100 / 1,000 / 10,000 rows all reconcile exactly.
Timings — 10 rows 10 ms, 100 rows 19 ms, 1,000 rows 187 ms, 10,000 rows 6.7 s.
Growth is slightly worse than linear at the top end but stays inside an
acceptable single analysis wait; revisit if a supported adapter exceeds
10,000 rows routinely. One missing required value across 1,000 rows produces
one grouped decision, not 1,000.

## 2. High-growth table architecture

| Table | Before | Decision |
| --- | --- | --- |
| `audit_logs` | 782,854 rows, partitioned earlier | already monthly-partitioned; bounded 180-day read window enforced by test |
| `role_grant_migration_log` | 207,401 rows / 60 MB, single heap | **now monthly-partitioned** |
| `role_permissions_base` | 101,599 rows / 107 MB | **not partitioned** — configuration state, not time-series history; partitioning it would fragment the permission resolution path for no retention benefit |

`role_grant_migration_log` was rebuilt as a range-partitioned table on
`created_at`, one partition per month plus a default, with a
`(organization_id, created_at DESC)` index on every partition. All 207,401
rows were copied and verified equal. The previous heap is retained as
`role_grant_migration_log_pre_partition`, frozen: no API grants, no writes.
Each partition has RLS enabled and no policies of its own, so history is only
reachable through the parent table, whose policy restricts every reader to
`organization_id = current_org_id()`. Verified by plan: a September-onwards
query prunes August and index-scans per workspace.

Storage: three identical unique indexes on `(role_id, permission_id)` in
`role_permissions_base` were reduced to the constraint-backed one, freeing
roughly 42 MB with no permission change.

Retention: periods, archive destinations and legal holds remain unset, so no
purge or archive runs. Partitioning is the prerequisite, not the purge.

## 3. Nullable workspace/organisation ID classification

Eleven base-table columns remain nullable. Each was examined individually; a
null is legitimate in every case, so none was forced to `NOT NULL`.

| Table | Rows / nulls | Why a null is legitimate |
| --- | --- | --- |
| `integration_webhook_receipts` | 0 / 0 | receipt is recorded before the workspace is resolved |
| `integrity_repair_jobs` | 3 / 2 | platform-wide repair jobs belong to no single workspace |
| `mpesa_callback_events` | 6 / 0 | a provider callback can arrive unmatched |
| `notification_templates` | 17 / 17 | system default templates, inherited by every workspace |
| `profiles` | 515 / 0 | legacy home workspace; with multi-group membership a person's workspaces live in `organization_memberships` |
| `provider_webhook_events` | 0 / 0 | as above, arrives before resolution |
| `provisioning_runs` | 129 / 0 | a run can fail before the workspace exists |
| `readiness_gates` | 80 / 20 | global gate definitions alongside workspace-specific ones |
| `uom_units` | 17 / 17 | global unit catalogue |
| `user_access_snapshots` | 5 / 2 | platform-wide access snapshots |
| `workspace_provisioning_attempts` | 18 / 9 | an attempt precedes the workspace it creates |

Enforcing `NOT NULL` on any of these would delete a legitimate global or
pre-workspace record class, so the rule is recorded rather than applied.

## 4. SECURITY DEFINER privileged-function audit

All 942 privileged functions are classified; zero remain `manual_review`.

| Classification | Count |
| --- | --- |
| tenant_validated_privileged | 484 |
| internal_privileged | 351 |
| tenant_derived_privileged | 88 |
| public_workspace_addressed | 16 |
| privileged_trigger | 3 |

The final four were settled with their reasoning recorded:
`neo_role_permission_ids` (identifier resolver, no records),
`hr_is_self` (self-check; the calling rule supplies scope),
`canonical_permission` (pure normaliser),
`neo_public_menu` (deliberate public surface, identifier constrained to the
published guest/booking context).

No function trusts a client-supplied workspace identifier. The 590 linter
advisories are the generic "signed-in users can execute a SECURITY DEFINER
function" notice; each of those functions validates workspace scope itself,
and blanket revocation would break the application.

## 5. Shared-request lifecycle guards

`src/lib/__tests__/shared-fetch-lifecycle.test.ts` covers the four events that
must drop shared state: workspace switch (query cache cleared and reloaded),
permission change (fingerprint reset before re-read), sign-out (full workspace
teardown), and multi-group identity (every workspace-scoped key carries its
group; the active group is read before the legacy one).

## 6. Deliberately preserved findings

- `INV-2026-000003` — open receivable, Serene Escape Group, balance 8,001,
  status under-review on a checked-out stay. A real business finding.
- 42 quarantined cross-workspace links (21 menu items, 21 recipes) between two
  groups; ownership is not provable, so they are flagged, not changed.
- Provider backup/PITR terms remain unrecorded because no provider fact has
  been supplied. No backup claim is made on their behalf.

## 7. Still requiring a person

A live money- and stock-moving walkthrough (PO approval → GRN → supplier
invoice → payable, and PMS check-in → checkout) has not been run: it needs an
explicitly authorised workspace. Nothing here substitutes for it.

## Money walkthrough — procurement to cost of sales (PASS)

Workspace: Zuri Crest Hospitality Ltd / Zuri Crest Hotel Nakuru. No fabricated master data.

| Step | Record | Result |
|---|---|---|
| Purchase order | LPO-MAIN-2026-000002 | approved independently, KSh1,200 |
| Goods received | GRN-MAIN-2026-000001 | 10 @ 120, accrual JV-MAIN-2026-000001 |
| Supplier invoice | CERT-SI-0001 | three-way matched, zero variance |
| Payable raised | JV-MAIN-2026-000002 | Dr GRNI 1,200 / Cr AP 1,200; PO fully-invoiced |
| Stock issue | movement 4fa6692d | Dr Cost of Sales 1,200 / Cr Inventory 1,200 |

Closing balances: Inventory 0.00, GRNI 0.00, Accounts Payable (1,200.00), Cost of Sales 1,200.00.

### Defects found and fixed
1. `neo_supplier_invoice_accept` correctly refused an IT/System Administrator (no `finance.approve`). Confirmed as designed — commercial approval authority is separately configured. Accepted by the Owner as an independent approver.
2. `neo_stores_issue` posted no financial entry: issued stock never left the Inventory asset account, so cost of sales was permanently understated. Fixed additively — issues and returns now post a consumption journal valued at recorded weighted-average purchase cost, with a configurable cost-of-sales account (default 5090, postable) and unvalued lines reported rather than estimated.

### Still outstanding
- PMS check-in to checkout: blocked — Zuri Crest has no room types, rooms or guests; creating them would be fabricated configuration.
- Tenant migration path, monthly partitioning of finance/inventory/PMS tables, duplicate people resolver: not yet implemented.

## Block P — Maintenance, Grounds & Assets

Fixed and verified this pass
- Grounds areas are a real, property-scoped list; grounds and landscaping work
  now choose a configured area and a canonical equipment asset, with due dates,
  assignment, progress, completion and blocking notes.
- Technicians issue real stock to a work order (store + item + quantity), with
  a caller-supplied key so a repeated tap cannot double-issue.
- Completed asset work orders write asset service history automatically.
- Fault categories and grounds areas are configurable and discoverable in the
  Configuration Centre.
- Inventory categories and item groups are covered by explicit shared
  canonicalisation tests: spelling variants merge, different concepts never do,
  existing records win over near-duplicates.

Security corrections made this pass
- Anonymous callers can no longer run grounds task creation, landscaping
  schedule saving, asset service recording, or entering a property portal.
- A role's permission list can no longer be read for a role outside the
  caller's own hotel group.
- Every newly added privileged routine is on the review register; the only
  deliberate signed-out surfaces are the published menu and the branded
  property sign-in page (public name, city, logo only).

Full suite: 3,274 passed, 1 skipped, 1 failed.

Open — business decision, not a defect
- One checked-out stay (folio INV-2026-000003, balance 8,001) is still
  under review with an unpaid balance. It needs a payment or an approved
  write-off; nothing was settled automatically.

Pending — environment dependent
- Live operator walkthrough of grounds, landscaping, stock issue and
  escalation in a real signed-in session has not been performed.
