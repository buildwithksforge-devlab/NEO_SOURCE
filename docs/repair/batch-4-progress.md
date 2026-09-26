# Batch 4 — Progress Ledger

## 1. User Management ⇄ Role Testing ⇄ actual logged-in access

- **Initial status:** IN PROGRESS → IMPLEMENTED
- **Root cause (two distinct defects):**
  1. User Management could only change `account_status`. There was no write path
     for an existing employee's roles, property, department or station, so an
     "assignment" made in the interface never reached `user_roles`,
     `user_branches`, `user_departments` or `user_stations`. Only newly created
     accounts ever received assignments.
  2. Role Testing / Workspace Preview resolved access with its own route→module
     map and raw `module:action` keys from `role_permissions`, while a real
     login resolves access through `permissionModuleForPath` plus the expanded
     canonical grant set (`module.feature.action`, module-wide class keys).
     The two maps disagreed, so a preview could show or hide pages the real
     session did not.
- **Files changed:**
  - `src/lib/permissions.ts` — grant expansion (`addGrant`) promoted to the
    shared registry so session, Role Testing and Preview expand identically.
  - `src/lib/auth.tsx` — now imports the shared expansion (behaviour unchanged).
  - `src/lib/workspace-preview-data.ts` — role grants read with `feature` and
    expanded through `addGrant`.
  - `src/lib/workspace-preview.ts` — `previewNavigation` now uses
    `permissionModuleForPath` and the same `module.*.view` check as the sidebar
    and `RouteAccessGate`.
  - `src/lib/users.functions.ts` — new `updateStaffAssignment` server function
    (admin-only, org-scoped, audited) writing profile, roles, branch, department
    and station together.
  - `src/routes/_shell.users.tsx` — "Edit assignment" dialog per staff row.
- **Database changes:** none. No schema, records or UUIDs were altered.
- **Authorization applied:** `requireSupabaseAuth` + `is_org_admin()` check;
  target profile must belong to the caller's organisation; every write is
  organisation-scoped; change recorded in `audit_logs` as
  `user.assignment_updated` with previous and new values.
- **Verification performed:** full TypeScript typecheck clean; permission
  resolution paths for session/preview now share one implementation.
- **Remaining blocker:** an end-to-end login as a non-admin staff member cannot
  be executed here (no staff passwords available). Marked BLOCKED for real-login
  evidence only.
- **Final status:** IMPLEMENTED (real-login verification BLOCKED)
- **Exact next action:** Requirement 2 — central Settings persistence, scope and
  inheritance.
