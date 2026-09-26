# Repair Owner workspace provisioning and recovery

## Root cause found

Workspace registration is correctly bound to the authenticated user, but provisioning is split across two overlapping routines and the current routine returns early as soon as **any** role assignment exists. That means a failed or older partial run can leave one role row while the creator profile, organisation link, property assignment, department assignment, permissions, defaults, or attempt completion marker remain missing. Future retries then report `existing` without repairing those missing links, and login is deliberately read-only, so the creator remains blocked.

A second defect is that the current recovery logic can infer a workspace from a matching organisation name or old email-based evidence. That is not a sufficiently strong ownership proof and conflicts with creator-only, tenant-safe recovery.

## Implementation

1. **Replace the fragmented provisioning finaliser with one transactional, idempotent database routine.**
   - Lock the authenticated creator’s provisioning attempt and a per-user transaction key.
   - Accept only an attempt whose stored `user_id` exactly equals the verified caller.
   - Create a new organisation only when the attempt has no organisation and the caller has no existing staff membership.
   - For an existing partial attempt, repair only the exact organisation already recorded on that creator-bound attempt.
   - Never recover by email, organisation name, or arbitrary role presence.
   - Upsert the creator profile, Owner role assignment, main-property assignment, Administration department assignment, role templates/permissions, settings, sequences, entitlements and finance defaults without replacing legitimate data.
   - Mark the attempt complete only after all required records exist; any failure rolls back the whole transaction.
   - Preserve System Administrator as an independent privileged role; never grant it to an Owner and never grant Owner to an ordinary member.

2. **Add an explicit creator-only recovery path.**
   - Expose a narrowly guarded authenticated recovery RPC that only finalises the caller’s own creator-bound incomplete attempt.
   - Permit recovery when the attempt already references the partial organisation, even if other default records or members were created during the failed transaction history.
   - Reject ordinary employees, unrelated tenants, ambiguous attempts and mismatched organisation/profile links.
   - Keep normal login read-only; the access screen may offer “Resume workspace setup” only when the backend marks the exact caller-owned attempt recoverable.

3. **Make access state and cache reflect completed provisioning.**
   - Tighten `recoverable` so it depends on exact `user_id` ownership, not email matching.
   - Invalidate stale effective-access snapshots after successful provisioning/recovery.
   - Return and validate the complete effective-access contract before the client declares the workspace ready.

4. **Regression and security tests.**
   - Add database-backed tests for all nine requested cases: fresh Owner access, re-login equivalence, Owner configuration authority, independent System Administrator authority, no employee escalation, no cross-tenant recovery, retry idempotency/no duplicates, partial-workspace creator recovery, and tenant-safe RLS.
   - Add source-level tests preventing future early-return-on-any-role and email/name ownership inference regressions.
   - Inspect the resulting function grants, RLS policies and security warnings.

5. **Verification.**
   - Apply the migration to Lovable Cloud.
   - Run focused provisioning/access tests, the broader authorization tests, TypeScript checks, and the required production smoke build.
   - Exercise the recovery and access flow with authenticated browser/database evidence where test identities permit, and report exact PASS/FAIL with any external blocker stated plainly.

## Safety constraints

- Additive/reversible migration; no deletion, UUID replacement, history mutation or live-data fabrication.
- No weakened access guard and no role-name shortcut in general authorization.
- No email-based ownership, no cross-tenant linking, and no automatic elevation of existing users.
