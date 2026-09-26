# High-growth tables, tenant-safe relationships and trusted-function audit

## What the database actually shows right now

| Table | Rows | Size | Note |
|---|---|---|---|
| audit_logs | 782,854 | 220 MB | 11 Aug – 19 Sep, one unpartitioned heap, no retention |
| rbac_baseline_role_permissions | 477,782 | 142 MB | frozen RBAC snapshot evidence |
| role_permissions_base | 101,599 | 107 MB | already de-duplicated this month |
| rbac_baseline_effective_access | 193,614 | 71 MB | snapshot evidence |
| role_grant_migration_log | 207,401 | 60 MB | write-once history, 21 Aug – 16 Sep |

Nullable `organization_id` appears on 23 tables (not 22): backup_records, defects,
feature_flag_overrides, integration_webhook_receipts, integrity_repair_jobs,
knowledge_articles, mpesa_callback_events, notification_templates, profiles,
provider_webhook_events, provisioning_runs, readiness_gates, role_grant_migration_log(+_archive),
security_findings_register, service_incidents, test_case_results, test_cases, test_runs,
test_suites, uom_units, user_access_snapshots, workspace_provisioning_attempts.

Trusted execution surface: 1,233 public functions, 928 SECURITY DEFINER. Of those,
108 contain no tenant-context reference at all (no `current_org_id`, `organization_id`,
`has_permission`, `is_org_admin`, `auth.uid`) — that is the audit shortlist, not 898.

## Stage 1 — Retention, archive and partitioning for growth tables

- One declared **records-retention register**: per table, class (audit / event / history /
  evidence), retention period, archive destination, who may purge, legal hold flag.
  No table is purged unless it has a register entry with an owner-approved period.
- `audit_logs`: convert to a **monthly range-partitioned** table, additively — create the
  partitioned table, copy in month partitions, swap names in one transaction, keep the old
  heap as `audit_logs_pre_partition` until reconciliation passes (row counts and checksums
  per month must match exactly). Indexes recreated per partition on (organization_id, created_at).
- Ageing: hot partitions stay online; partitions past the retention window are detached and
  written to compressed archive rows (or snapshot chunks) rather than deleted, with a
  deletion certificate line per detached partition.
- `role_grant_migration_log`: write-once history with a natural cutoff. Move everything
  older than the retention window into the existing `role_grant_migration_log_archive`,
  keeping the query view unioned so history reads unchanged.
- RBAC baseline snapshot tables: these are frozen evidence from the permission rework.
  Give them an explicit retention decision (keep N runs, archive older runs) — they are the
  second-largest consumer and currently have no expiry at all.
- Query contract: every read of a partitioned table must filter on the partition key.
  A test asserts the app's audit/event queries carry a time bound, so pruning actually happens.
- Compliance: retention periods, purge runs and legal holds all land in the register and in
  the Recovery Centre's evidence view.

## Stage 2 — Tenant-safe relationships (structural, not RLS)

Not all 1,341 foreign keys. Only the relationships where a cross-tenant row would be a
financial, inventory, PMS or security incident:

- Finance: journal lines → accounts, folio lines → folios, payments → invoices, AP invoice
  lines → purchase orders.
- Procurement/Inventory: PO → supplier, PO lines → items, GRN → PO, stock movements →
  item/store/location, transfers → both stores.
- PMS: reservation → room/room type/rate, folio → reservation, charges → folio.
- Security/RBAC: user_roles → role, role_permissions_base → role/permission, approval
  rules/requests → property and approver role.

Mechanism per relationship: ensure the child carries `organization_id` (and `branch_id`
where the parent is property-scoped), add a unique key on the parent `(id, organization_id)`,
then a **composite FK** `(parent_id, organization_id) → (id, organization_id)`. Each one is
validated against existing data first; any violating row is reported, never auto-repaired.
Rolled out in batches by domain, each batch reconciled before the next.

## Stage 3 — Classify the nullable organisation IDs

Each of the 23 is classified as **platform-global** (NULL intentional: e.g. platform
`uom_units` defaults, `notification_templates` platform defaults, `provider_webhook_events`
pre-resolution, `feature_flags` overrides) or **tenant-owned** (NULL is a defect).
Tenant-owned ones get: a backfill report, then NOT NULL plus the composite key from Stage 2.
Platform-global ones get a documented partial policy so a NULL row cannot be read as
belonging to a tenant. `profiles.organization_id` is deliberately deferred to Stage 5.

## Stage 4 — SECURITY DEFINER audit as an automated suite

- A classifier function grades every SECURITY DEFINER function: does it set `search_path`,
  does it establish tenant context before touching data, does it check a permission, is it
  executable by `anon`/`public`.
- Findings register lists each function with its grade and domain (finance, payments,
  imports, reports, integrations, automation, HR, POS, stock, administration).
- A **test that fails the build** when a new or changed SECURITY DEFINER function in a
  sensitive domain has no tenant context and no permission check, and when any is granted
  to `anon`/`public`. Known-safe pure helpers sit on an explicit reviewed allowlist.
- Start with the 108 with no tenant reference at all; most will be pure helpers, the rest
  are the real risk.

## Stage 5 — Multi-tenant identity: a decision, not a default

Today `profiles.organization_id` binds one human to one workspace, and property access is
already handled inside an organisation by `user_branches`. Multi-property within one
organisation is the immediate requirement and already works.

Before any schema change, this needs your product decision:

- Keep one identity = one workspace (staff-only model), and serve management companies,
  external accountants and group administrators through separate logins per workspace; or
- Introduce a membership model (one identity, many workspaces, each with its own roles and
  property scope), which changes session context, the workspace switcher, RLS context
  functions and every `current_org_id()` consumer.

The plan records this as an open decision. Nothing is built for it in this pass, and nothing
is done that would make either choice harder.

## Guardrails across every stage

- Additive and reversible; no destructive statement on a live table without an approved,
  reconciled archive first.
- Row counts and checksums compared before and after every move; zero unexplained variance.
- No fabricated retention periods, provider terms or business decisions — they are recorded
  facts entered by you or left "Not established".
- Each stage ends with evidence: reconciliation output, EXPLAIN before/after, test results.

## Sequencing

Stages 1 → 3 → 2 → 4, with 5 as a decision only. Stage 3 precedes Stage 2 because the
composite keys need non-null tenant columns to attach to.
