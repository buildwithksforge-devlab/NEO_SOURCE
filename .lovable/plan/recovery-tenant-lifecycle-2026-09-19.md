# Recovery & Tenant Lifecycle

## What exists today (verified, not assumed)

- **Level 1 — normal mistake / application correction**: present and working. Journal reversal, folio line reversal, finance posting reversal, goods-receipt reversal, package allocation reversal, HR offboarding — all with reason capture and audit.
- **Level 2 — bad import**: present. The onboarding engine reverses a whole batch, skips records that already have downstream activity, marks the batch reversed and writes an audit entry.
- **Level 3 — property recovery**: missing. Nothing can roll a single property back to an earlier state.
- **Level 4 — tenant recovery**: missing. No snapshot, no export, no restore, no offboarding, no deletion path for a live workspace. The only purge routine is TEST-environment only.
- **Level 5 — platform incident**: outside the app. `backup_records` exists with the right shape (type, scope, environment, location, verified, restore_tested_at, restore_result, retention) but holds zero rows, so no backup has ever been recorded or restore-tested here.

## The provider question (must be answered before the rest is trusted)

Whether the hosted database has automated daily backups and point-in-time recovery, how far back, and in which region cannot be established from inside the database — that is a hosting-plan fact, not a schema fact. The backend currently runs on the smallest instance tier. I will not guess a retention window. Action: you confirm the backup/PITR terms with Lovable support, and we record the answer as a first-class, dated entry in the environment registry so it is visible in-product instead of living in someone's memory.

## What I will build

### 1. Tenant snapshot service
A snapshot captures one workspace (optionally one property) as an immutable, versioned bundle: every tenant-keyed table, row counts, a manifest with checksums, and the RBAC/effective-access state already captured by the permissions baseline work. Stored in a private tenant-scoped bucket, written only by a service-role routine, readable only by that workspace's administrators. Every run writes a `backup_records` row, so the table stops being empty and starts being evidence.

Modes: on demand, before any destructive operation (import commit, property closure, offboarding), and a scheduled cadence per workspace.

### 2. Restore with dry-run first
Restoring always produces a comparison first — what would be added back, what would be overwritten, what exists now that the snapshot does not know about, and what cannot be safely touched because it has downstream activity (postings, payments, audit). Nothing is written until an administrator approves that comparison, with a reason. Restores are recorded and reversible in turn.

Two scopes:
- **Property recovery** — restores the records belonging to one property, leaving the rest of the workspace untouched.
- **Tenant recovery** — restores a whole workspace.

Financial history is never silently rewritten: posted journals, settled payments and audit rows are restored by compensating entry, not by overwrite.

### 3. Restore drills
A drill restores a snapshot into an isolated verification scope, compares row counts and checksums against the manifest, then records the result on the snapshot's `backup_records` row (`verified`, `restore_tested_at`, `restore_result`). An untested backup is displayed as untested, never as protection.

### 4. Tenant lifecycle: export → suspend → delete
- **Export** — an administrator downloads their workspace as a portable bundle (structured data plus attachment manifest). This is also the offboarding artefact.
- **Suspend/freeze** — access is closed, data is retained read-only, nothing is destroyed. Reversible.
- **Scheduled deletion** — only after a verified export and a suspension grace period, requested by one administrator and approved by another, with a countdown that can be cancelled throughout.
- **Purge** — executes only when export is verified, grace period elapsed, and both approvals stand. Writes a deletion certificate (what was removed, when, by whom, export reference) that survives the tenant.

### 5. Recovery Centre screen
One place under Platform showing, per workspace: latest snapshot and its age, last verified restore drill, provider backup/PITR terms as recorded, the five recovery levels with which ones are currently available, and the lifecycle state. Each level links to the action that performs it.

## Guardrails

- Additive migrations only; no existing table dropped, no historical row rewritten.
- Every snapshot, restore, drill, export, suspension and deletion is permission-gated, tenant-scoped, idempotent, reason-carrying and audited.
- Deletion and restore both require two distinct people; no self-approval.
- No fabricated backup records, retention windows, or restore results — a value is written only when a real run produced it.

## Technical notes

Snapshot/restore/export run as service-role routines invoked through guarded server functions, chunked to stay within statement timeouts and resumable on failure, reusing the batching pattern already used by the RBAC baseline capture. Table scope is derived from the tenant-key classification produced during the database inventory, so new tables are included automatically and a table with no tenant key is flagged rather than silently skipped. Storage uses the existing private tenant bucket convention. `neo_test_purge_org` stays TEST-only and is not reused for live deletion.

## Sequence

1. Record provider backup/PITR terms (needs your answer from support).
2. Snapshot service + `backup_records` population.
3. Restore dry-run and property recovery.
4. Tenant recovery + restore drills.
5. Export, suspend, scheduled deletion, deletion certificate.
6. Recovery Centre screen and end-to-end drill on a TEST workspace.
