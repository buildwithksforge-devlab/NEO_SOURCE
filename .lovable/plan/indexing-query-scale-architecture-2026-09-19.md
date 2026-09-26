# Indexing & query-scale architecture

Agreed: we do not add 305 indexes. Indexes follow measured query shapes and projected volume. Everything below is grounded in evidence already collected from the live database (pg_stat_statements, pg_stat_user_tables, existing index definitions, actual policy text).

## What the measurements actually say

Three findings change the shape of the work:

**1. The app almost never sends `organization_id` in its filters.** The real query shapes are: filter on `branch_id` (or nothing at all), order by `created_at DESC`, page with LIMIT/OFFSET. Tenant scoping arrives from the RLS policy, not the request. So the correct index shape is `(organization_id, branch_id, created_at DESC)` for property feeds and `(organization_id, created_at DESC)` for organisation-wide feeds — not a bare `organization_id` index.

**2. The slowest queries today are on tables that already have the right index.** `audit_logs` has `(organization_id, created_at DESC)` and it is being used, yet the listing still averages 136 ms. `notifications` has `(organization_id, branch_id, created_at DESC)` and averages 182 ms over 3,678 calls. Indexing is therefore necessary but not sufficient — the per-row cost of the policy predicate is the co-equal problem.

**3. Policy predicate style is inconsistent and that is a scaling defect.** `menu_items` and `notifications` wrap their context functions as `(SELECT current_org_id())`, which Postgres evaluates once per query. `audit_logs` calls `current_org_id()` and `is_org_admin()` bare, and `stock_movements` calls `can_read_stock()` and `in_my_config_scope()` bare plus a correlated `EXISTS` against `stock_locations`. Bare calls are re-evaluated per candidate row; at 100 M rows that dominates everything an index can save.

Counts that frame the budget: 545 organisation-keyed tables, 305 with no organization_id index at all, 1,708 policies, 612 k audit rows and 239 k role_permissions rows at only 28 tenants.

## Classification, not a blanket rule

Every organisation-keyed table lands in exactly one class.

| Class | Test | Index policy |
|---|---|---|
| A — High-volume operational feed | Grows per transaction/day/guest; projected > 1 M rows per 1,000 tenants | One composite matching the real read path: `(organization_id, branch_id, created_at DESC)` or the module's business date |
| B — Filtered work queue | Read as "open items for my property" | `(organization_id, branch_id, status)`, partial `WHERE status IN (open states)` where the closed states dominate |
| C — Master data | Bounded per tenant (hundreds to low thousands) | One `(organization_id, <primary sort or lookup key>)`; no more |
| D — Configuration / singleton | A handful of rows per tenant | No new index; the existing unique constraint or PK suffices |
| E — Child/line tables | Always read through a parent id | Index the parent FK, not organization_id |
| F — Platform catalogue | No tenant key | Out of scope |

Class E matters: several current seq-scan offenders (`purchase_order_lines`, `supplier_invoice_lines`, `recipe_ingredients`, `pos_order_item_modifiers`) need a parent-FK index, and adding organization_id to them would be waste.

## Staged delivery

**Stage 1 — Classify and record.** Produce a machine-checkable classification of all 545 tables with a projected row count per 1,000 tenants and the declared read path for each. Stored in the repo so future tables must declare a class. No schema change.

**Stage 2 — Class A and B indexes, evidence-led.** Build indexes only for tables where the classification and current statistics agree. Each index is validated with `EXPLAIN (ANALYZE, BUFFERS)` on a reconstructed real query before and after. Expected to be on the order of 40–70 indexes, not 305. Known candidates from current data: `audit_logs` (branch variant), `approval_requests`, `tasks`, `stock_movements`, `goods_receipts` (branch variant), `purchase_orders`, `pos_shifts`, `leave_requests`, `guest_requests`, `overtime_requests`, `shift_swap_requests`, `station_tickets`, plus the Class E parent FKs above.

**Stage 3 — Policy predicate normalisation.** Rewrite bare context-function calls in policies to the `(SELECT fn())` InitPlan form so they evaluate once per query rather than once per row, starting with `audit_logs` and `stock_movements`. Semantics unchanged — same functions, same result, different evaluation count. This is where the largest latency win lives and it is why Stage 2 alone would under-deliver.

**Stage 4 — Redundancy removal.** Drop genuinely duplicate indexes found during the work (for example `event_bookings` currently carries three overlapping unique indexes on the same reference, and `domain_events` carries two near-identical idempotency uniques). Write amplification is a scaling cost too.

**Stage 5 — Standing guard.** A test that fails when a new organisation-keyed table is added without a declared class, and when a Class A or B table has no index whose leading column is organization_id. This is what stops the gap reopening at table 600.

## Explicitly out of scope here

Partitioning of `audit_logs` and `role_grant_migration_log`, and the `role_permissions` row-explosion (~8.5 k rows per tenant, projecting to ~85 M at 10 k tenants), are separate architectural decisions. They interact with this work but should not be folded into it.

## Verification

For each index shipped: reconstructed query, plan before, plan after, index scan confirmed, and a statement of what it costs on write. No index ships on "it looks sensible". Nothing in this plan writes, alters or deletes operational data.

## Decision needed

How far should I go in this pass — Stage 1 alone (the classification and evidence, no schema change), Stages 1–3 (classification, the evidence-led indexes, and the policy predicate fix), or all five stages including redundancy removal and the standing guard?
