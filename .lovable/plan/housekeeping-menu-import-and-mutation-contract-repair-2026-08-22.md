# Housekeeping, Menu Import, and Mutation Contract Repair

## Confirmed live findings

- Menu batch `684f84f1-27d9-4d10-8dcd-24494b324f95` exists with 77 parsed/imported rows and zero rejected rows.
- All 77 rows exist in the canonical `menu_items` table as Draft, but all 77 have no property, no menu-linked category, and no item station. The organization has no canonical menu. The rows are therefore committed but orphaned/hidden by the active property query—not a successful usable import.
- The importer counts validated rows as imported before reloading them through the normal Menu Management query, invalidates the wrong query keys, suppresses audit failures, and closes the dialog after this false success.
- `log_audit_event` accepts a UUID correlation argument, while current frontend correlation IDs are human-readable text. That contract mismatch explains the HTTP 400 audit failures.
- `hk_create_job` checks legacy broad permissions rather than `housekeeping.tasks.create`, does not accept/validate an assignee or manual reason, does not populate the full scope contract, emits no durable workflow event or attributable audit event, and broadcasts notifications instead of targeting the resolved recipient.
- Checkout marks the authoritative room dirty but creates only a generic task; it does not create the linked `housekeeping_jobs` record required by the Housekeeping UI.
- The current manual Room Board button always requests departure cleaning—even for occupied or already-clean rooms—and has no form for task type, reason, due time, or eligible assignee.
- The codebase currently has hundreds of direct mutation call sites. Global verification must be registry-driven and staged; it cannot honestly be marked verified from static inspection.

## Implementation

### 1. Establish the reusable mutation contract

- Add a shared typed mutation runner for Create/Save/Edit/Assign/Complete/Approve/Post/Import/Retry actions.
- Standardize canonical capability checks, scope context, input normalization, schema validation, UUID correlation IDs, deterministic idempotency keys, structured backend errors, persisted-record reload, cache invalidation, workflow/audit outcomes, and truthful full/partial/failure results.
- Add durable repair recording for audit or downstream failures after a primary commit; never downgrade a partial commit to ordinary success.
- Add an automatically generated control registry by scanning registered route mutation declarations, with explicit action, route, capability, mutation target, reload query, downstream evidence, and verification status.

### 2. Repair the Housekeeping database transaction

- Extend the housekeeping job contract additively with property/room type/station or zone/source/source reference/correlation/team assignment fields where the current schema lacks them.
- Replace the creation path with one transactional RPC that:
  - validates `housekeeping.tasks.create`, authenticated scope, authoritative room, occupancy/task-type compatibility, cleaning need/manual reason, and eligible active assignee/team;
  - prevents equivalent active jobs with a deterministic idempotency key;
  - creates the canonical housekeeping job and linked task;
  - updates the authoritative room condition and sellability;
  - emits a durable domain event, actionable recipient notification, and attributable audit evidence;
  - returns a reloadable result containing every created identifier and outcome.
- Harden start, complete, pass, and fail inspection operations as transactional RPCs with canonical permissions, personal/team scope, history, notifications, room-state recalculation, and idempotency.
- Make checkout call the same housekeeping creation primitive in its transaction so departure cleaning creates exactly one real job and cannot diverge from manual recovery.
- Keep all changes additive and preserve existing UUIDs/history.

### 3. Repair Housekeeping UI and shared room state

- Keep `rooms` as the single room source used by Front Office, Room Rack, reservations, maintenance, and Housekeeping.
- Expand the shared Room Board projection to show occupancy, cleaning condition, inspection, maintenance block, sellability, active task, assignee, property, department, and configured station/zone.
- Replace the one-click departure-clean button with a permission-aware exception dialog for task type, reason, priority, due time, and eligible assignee/team.
- Preserve values and keep the dialog open on failure; show exact actionable backend errors and precise partial-success states.
- Restrict Housekeeper views/actions to personal assignment and configured scope; supervisors get scoped assignment/inspection controls; Front Office remains readiness-only unless separately granted.

### 4. Repair menu creation and import transaction

- Replace generic `useSaveRecord("menus")` usage with a canonical menu mutation that validates capability/scope/name/property/service context, applies idempotency, reloads through the normal RLS query, audits, and only then reports success.
- Move CSV import persistence into one transactional backend operation using the selected canonical menu and property:
  - validate headers/rows and create the batch;
  - resolve/create permitted categories under that menu;
  - resolve inherited or explicit preparation stations;
  - insert only valid Draft canonical items;
  - classify duplicates, mapping-required rows, rejected rows, and rolled-back rows;
  - reload committed rows through normal scope;
  - emit audit/workflow evidence and return confirmed totals.
- Add status filters for All, Draft, Published, Unavailable, Archived, Needs mapping, and Import errors.
- Invalidate the actual `pos` query keys and preserve the import dialog on full or partial failure.

### 5. Recover the existing menu batch without duplication

- Preserve all 77 existing item UUIDs and the original batch.
- Link the 19 existing categories to a deterministically selected canonical menu only when the menu/property relationship is unambiguous; otherwise expose them in the mapping queue.
- Inherit the already-recorded category station mappings onto the 77 items where valid.
- Backfill property/menu relationships and batch classification idempotently under correlation `menu-import-20260822-f036b517`.
- Record recovery audit/workflow evidence and verify the same 77 items appear through Menu Management after refresh; do not re-import rows.

### 6. Fix audit correlation and repair handling

- Align the correlation contract end to end by using UUID correlation values internally and a separate human-readable reference where required.
- Update every frontend audit call to the deployed function signature and return the audit UUID.
- Queue durable audit repair when the primary transaction has committed but audit insertion fails, and surface the exact partial-success message.

### 7. Verification and evidence

- Add contract tests for payload/schema compatibility, permission visibility, idempotency, reload confirmation, truthful failure/partial states, and generated route-control coverage.
- Run authenticated browser/database acceptance tests with controlled QA records only after identifying an authorized existing QA scope; do not create operational-looking sample data.
- Housekeeping acceptance will capture room, task, notification, workflow and audit UUIDs plus every before/after room state; test assignee visibility, another worker’s denial, refresh/re-login persistence, duplicate retry, failed inspection/rework, passed inspection/release, Front Office parity, and automatic checkout handoff.
- Menu acceptance will prove menu creation, import/recovery visibility, RLS agreement, persisted totals, duplicate retry, audit evidence, and refresh/re-login persistence.
- Generate the prioritized platform failure report for every registered mutation control. Mark each control Verified, Failed with exact root cause, Blocked (no safe QA fixture/actor), or Not Verified. Housekeeping and global controls remain **NOT VERIFIED** until live evidence exists.

## Technical constraints

- Use migrations for schema, function, trigger, GRANT, and RLS changes; no direct schema writes.
- Preserve tenant scope, existing IDs, live records, and audit history; no destructive cleanup or broad RLS grants.
- No hardcoded role names. Authorization uses effective `module.feature.action` capabilities and server-enforced scope.
- No false-success toasts: a mutation is successful only after normal-path reload confirms persistence and required downstream outcomes are reported.
