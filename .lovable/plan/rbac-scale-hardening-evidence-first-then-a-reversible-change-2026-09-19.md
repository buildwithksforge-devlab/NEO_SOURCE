# RBAC scale hardening — evidence first, then a reversible change

## Phase 1–2 findings (already measured, read-only, nothing changed)

**What exists today**

| Structure | Count |
|---|---|
| Canonical permissions | 2,194 |
| Organisations / properties | 28 / 32 |
| Roles (all org-owned rows) | 1,641 — 1,597 flagged system, 1,534 active, 31 with no permissions |
| role_permissions | 238,891 |
| user_roles | 516 |
| user_permissions (explicit grant/deny) | **0** |
| role_feature_templates / role_permission_templates | 3,974 / 3,833 |
| role_grant_migration_log | 207,401 (157,186 revoked, 50,215 granted; 21 Aug – 16 Sep 2026) |

**Why there are ~239k rows.** Every organisation gets a physical copy of every built-in role, and every role gets a physical copy of every template permission. 1,641 roles × ~148 permissions average = ~239k. There is no inheritance; the template is materialised per org, per role, per permission.

The concentration is extreme at the top:

| Role key | Instances | Rows | Distinct permission shapes across orgs |
|---|---|---|---|
| owner | 28 | 48,071 | 4 |
| it-system-administrator | 28 | 20,427 | 4 |
| owner / director (legacy name) | 12 | 19,404 | 2 |
| it/system administrator (legacy name) | 12 | 17,968 | 2 |
| operations-manager | 28 | 12,989 | 4 |

Those four superuser keys alone are **105,870 rows — 44% of the table**. Each owner role carries ~1,717 of the 2,194 permissions. And `has_permission()` already short-circuits on `is_org_admin()` before it ever reads `role_permissions`, so for these two roles the rows are read only by the Roles & Permissions UI, never by the security path.

Across every other key, 28–36 org copies collapse into only **2–7 distinct permission shapes** — meaning most orgs are still on an unmodified default, and a few have genuinely diverged.

**Resolution path today.** `has_permission(module, feature, action)` is `STABLE SECURITY DEFINER`: it resolves denies from `user_permissions`, grants from `user_roles → roles → role_permissions`, canonicalises through `canonical_permission()` and `permission_action_class()`, applies deny-over-grant, and exempts org admins. `my_effective_access()` already caches a per-user snapshot in `user_access_snapshots`, versioned by `my_permission_version()` with `neo_bump_access_epoch()` invalidation.

**Conclusion: the deny model, the override table, the cache and the invalidation epoch are already correct.** The defect is purely materialisation volume, and the redundancy is provable only where an org's role is byte-identical to its template.

## What I propose to do

### Stage A — Snapshot and baseline (no schema change)
Freeze a full RBAC baseline into an immutable table: every role, role_permission, user_role, user_branch, scope field, plus a full effective-access matrix (user × org × property × permission × effect × source). This is the reconciliation reference for everything after it, and the rollback source.

### Stage B — Classify every role_permission row
Tag each row against its canonical template as `default` (exactly reproducible from the template the role derives from), `added` (org granted beyond template), or `removed` (template line the org dropped — stored as an explicit negative). Only `default` is a candidate for de-materialisation. Nothing is deleted in this stage; the classification is written alongside.

### Stage C — Inheritance without losing templates
Introduce template linkage on `roles` (template key + template version + follow/diverged state) and an override table holding only intentional differences. `has_permission()` and the effective-access builder resolve template ∪ added − removed. The Roles & Permissions screen keeps showing the full expanded permission list — it just reads it from the resolver instead of from cloned rows.

### Stage D — Dual evaluation before any switch
Run old and new resolution side by side for every user × permission in the baseline matrix. Unexpected grants must be 0, removals 0, scope changes 0. If reconciliation is not exact, the legacy rows stay and the switch does not happen.

### Stage E — De-materialise proven-default rows only
Delete only rows Stage B proved `default` AND Stage D reconciled exactly, and only for roles still marked as following their template. Projected: ~239k → roughly 10–25k, with the superuser rows going first because they are the largest and the least load-bearing. Diverged roles keep every row they have.

### Stage F — Versioning, provisioning, guards
- Template version stamped on each role; when NEØ ships a template change, following orgs adopt it automatically and diverged orgs surface a "template has changed — review / adopt / keep" prompt. No silent overwrite.
- New-tenant provisioning creates role rows + template links instead of ~8,500 permission rows, and a new hotel still opens Roles & Permissions to the full built-in catalogue.
- New-property provisioning clones nothing; property scope stays on the assignment.
- Regression tests: deny precedence, multi-role conflict, cross-tenant read/assign/edit, property-scope escape, role removal, deactivation, maker/checker and approval authority unchanged, and a guard that fails the build if a future change reintroduces per-org permission cloning.

### Stage G — role_grant_migration_log
It is migration evidence, not operational state: two operations (`granted`, `revoked`) over a 26-day repair window, written by the role-model repair runs. I propose retaining it as audit but moving rows older than the last completed migration run into a compressed archive table, rather than deleting it.

## Performance
`has_permission()` latency, a representative RLS-filtered list query, role assignment, role edit and tenant provisioning are each measured before Stage C and again after Stage E. If the resolver is slower than the materialised read, the inheritance resolution gets its own per-request memoisation before the switch — the switch does not proceed on a latency regression.

## Explicitly not doing
No template deletion, no role merging, no customisation reset, no flattening of multi-property scope, no weakening of RLS or deny precedence, no irreversible one-shot rewrite. Every stage is additive until Stage E, and Stage E is gated on exact reconciliation.

## Decision
This is a large programme. Do you want me to run **Stages A–B only** (snapshot, baseline matrix and the redundancy classification — full evidence, zero schema risk), **A–D** (adds the inheritance model running in parallel, still with all legacy rows intact), or **A–G** (through de-materialisation, versioning, provisioning and the guards)?
