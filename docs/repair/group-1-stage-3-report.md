# Group 1 — Stage 3: Identifier Service (COMPLETE)

Date: 2026-08-19 · Checkpoint: migration `issued_document_numbers` + hardened `next_document_number`

## Hydration / tenant-settings protection (pre-check, done)

`src/lib/tenant.tsx` now guarantees:

| Requirement | Implementation |
|---|---|
| Wait for auth + hydration before writing | `hydrate()` resolves the org first; save effect returns while `!hydrated` |
| Never persist defaults during loading | Save effect requires `lastPersisted.orgId === organizationId` |
| Never overwrite DB with stale local state | Snapshot comparison against last confirmed DB version |
| Explicit hydrated state | `hydrated` state + `hydrationToken` ref for stale-response cancellation |
| Persistence only after hydration | Guarded in save effect |
| Cancel pending writes on sign-out / org change | `cancelPendingSave()` on `SIGNED_OUT` and at the start of every `hydrate()` |
| Writes scoped by authenticated org | `orgAtEdit` captured at edit time; write skipped if `tenant.organization.id` differs |
| No cross-org write | Same guard; hydration token invalidates in-flight loads |
| Preserve last confirmed DB version on failure | Failed write leaves `lastPersisted` untouched so a retry re-attempts |
| No write loop from hydration | Loaded state is snapshotted, so it is not treated as a user edit |

Rollback note: organization settings hold live data. Rollback is by
`organization_settings` row export + application-path revert, never `DROP TABLE`.

## Stage 3 verification

| Check | Result |
|---|---|
| Existing UUIDs unchanged | Yes — no UPDATE/DELETE on identity columns; migration is additive |
| Existing valid references unchanged | Yes — no rewrites of any document reference |
| Missing references backfilled safely | Registry accepts backfill via `register_imported_document_number()` |
| Duplicates identified before constraints | `duplicate_document_numbers()` report; registry unique index is per (org, doc_type, number) only |
| Server-side generation | `next_document_number()` SECURITY DEFINER; no client-side numbering remains |
| Atomic | Single `INSERT … ON CONFLICT … DO UPDATE … RETURNING` increment |
| No `MAX(number)+1` | Confirmed by code search across `src/` and DB functions |
| Org-scoped sequences | `current_org_id()` required; NULL org raises |
| Branch codes optional + validated | Branch must belong to the active org, else exception; blank codes omitted |
| Yearly reset | `next_number` resets to 1 when `year` changes, in the same atomic statement |
| Imported references do not disturb sequences | Recorded in registry only; generator skips a collided number and advances |
| Voided references never reused | `void_document_number()` marks status void; row stays, blocking reuse |
| Concurrency-safe | Unique index `number_sequences_org_doc_branch_idx` serialises the upsert; registry unique index is the second guard |
| Shared service everywhere | approvals, tasks, work-order, requisition, purchase-request, journal, events all call the RPC |

## Record counts (post-migration)

orgs 4 · branches 5 · departments 60 · profiles 34 · roles 122 · user_roles 35 · number_sequences 55 (unchanged)

## Removed legacy structure

`number_sequences_organization_id_doc_type_key` / `number_sequences_org_doctype_idx` —
superseded by the branch-aware unique index, which was already present and verified.
No rows affected.

Status: **GO** for Group 2.
