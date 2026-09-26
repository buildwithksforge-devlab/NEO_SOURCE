# Restore the approved role catalogue and controls

## Scope
- Preserve all existing historical templates and tenant-specific permissions.
- Add narrowly scoped platform templates only for the nine confirmed gaps.
- Reactivate only the ten explicitly approved historical roles.
- Keep Porter/Bell Attendant and Night Auditor unavailable for new assignment while preserving history.
- Do not run a workspace-wide permission rollout.

## Implementation
1. Snapshot the affected catalogue and template rows in database-readable audit tables before correction.
2. Validate canonical role keys, role policies, current permission keys, and historical template provenance.
3. Add exact role-specific grants for the nine missing templates; reject unavailable keys and whole-module shortcuts.
4. Reactivate the ten approved roles without changing their historical template rows; report unresolved obsolete keys instead of broadening.
5. Remove stale current Night Auditor hierarchy/default-assignment references while retaining historical assignments and flagging current assignees for reassignment.
6. Implement configurable, property-scoped approval fallback to Operations Manager only when the configured departmental approver is unavailable; preserve Owner-reserved thresholds, prevent self-approval, and audit every fallback.
7. Repair delete controls end to end, including authorization feedback, dependency blockers, successful refresh, and adjacent affected controls.
8. Add automated checks for exact templates, restricted actions, registry resolution, fallback routing, scoping, self-approval, Owner reservation, audit records, and delete behavior.

## Validation and report
- Run focused tests, type checking, the project smoke/build check, and authenticated browser checks where an eligible account is available.
- Produce exact module/feature/action tables for all nine new templates, cross-department justifications, registry warnings for the ten restored roles, and PASS/FAIL status for all requested roles plus Porter/Bell and Night Auditor.
- Report any blocker truthfully; zero missing grants alone will not count as certification.

## Safety assumptions
- “Historical template” means existing `role_permission_templates` rows keyed by canonical backend role key; these rows remain unchanged unless a referenced permission is proven nonexistent.
- No role grants are applied to organization roles in this change.
- Existing deliberate organization exceptions remain untouched.
