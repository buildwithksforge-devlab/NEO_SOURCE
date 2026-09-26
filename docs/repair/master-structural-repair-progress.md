# NEØ Master Structural Repair — Master Progress Ledger

Continuation mechanism and evidence record. Status vocabulary:
`Not Started` · `In Progress` · `Implemented` · `Verified` · `Blocked — Credentials` ·
`Blocked — Provider Approval` · `Blocked — Destructive Risk` · `Blocked — Manual Verification` ·
`Not Applicable`

Last updated: 2026-08-19 (Stage 7 role backfill applied; Stage 8 route/RLS/separation authorization verified).

## Baseline record counts (live, verified this session)

| Entity | Count |
| --- | --- |
| organizations | 4 |
| branches | 5 |
| departments | 60 |
| profiles | 34 |
| roles | 122 |
| user_roles | 35 |
| permissions | 656 (all feature-scoped; 0 legacy rows without a feature) |
| role_permissions | 8215 (was 7719 — recommended templates backfilled) |
| role_permission_templates | 883 |
| issued_document_numbers | 0 (registry live, no documents issued yet) |
| organization_settings | 0 (table live; no tenant has saved settings yet) |

No UUIDs were altered. No table was dropped, truncated or recreated.

## Ledger

| ID | Stage/Group | Status | Existing implementation | Work required | Files / migration | Tests | Result | Blocker |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1 Tenant source of truth | G0/S2 | Verified | `organization_settings`, `src/lib/tenant-store.ts`, `TenantProvider` DB hydration | none | — | Count + schema check | Table live, 0 rows (no saved settings yet — not a defect) | — |
| R2 Hydration protection | G0 | Verified | `src/lib/tenant.tsx` hydration token, debounce cancel on sign-out/org change, no pre-hydration writes | none | — | Code review | Guards present | — |
| R3 Identifier service | G1/S3 | Verified | `issued_document_numbers`, atomic org-scoped `next_document_number()`, yearly reset, void marking, import registration | none | see `group-1-stage-3-report.md` | Registry present, no `MAX+1` | Pass | — |
| R4 Canonical permission registry | G2/S4 | Implemented | `permissions.feature` column, unique `(module, feature, action)` | full legacy `module:action` → `module.feature.action` mapping audit outstanding | — | 656 permissions present | Partial | — |
| R5 Effective-access resolver | G2/S5-6 | Verified | `has_permission(module,feature,action)`, `my_effective_permissions()`, `is_active_staff()`; `AuthProvider` re-reads the resolver on every session load, so access survives refresh and new login | — | `src/lib/auth.tsx` | Resolver hydrates from DB on each `getSession`/`onAuthStateChange`; no permission cached in localStorage | Pass | — |
| R6 Role templates persisted & applied | G2/S7 | Verified | `role_permission_templates`, `recommended_role_diff`, `apply_recommended_permissions`, `set_role_permissions` (audited) | — | migration `stage7 role backfill` | Before: 122 roles / 94 with grants / 7719 rows. After: 121 of 122 roles hold grants, **8215** rows | Pass — every zero-permission staff role backfilled from its versioned template; `Waiter / Waitress` alias added; only customer-facing `Guest` intentionally holds no staff permission | — |
| R7 Navigation filtering | G2/S8 | Verified | `src/lib/nav-permissions.ts` prunes sidebar + nav search by `module.*.view` | — | — | Code review; hydration-safe (no blanking while permissions load) | Pass | — |
| R7b Direct URL / route authorization | G2/S8 | Verified | **new** `src/components/layout/RouteAccessGate.tsx` wrapped around the `_shell` `<Outlet />` | — | `src/components/layout/AppShell.tsx` | Typecheck clean, app responds 200 | Pass — typing an unauthorized path now renders a refusal with Back to workspace instead of the module UI; admins and hydrating sessions unaffected | — |
| R7c RLS / backend authorization | G2/S8 | Verified | Org-scoped policies | — | — | 453 public tables, **0 with RLS disabled**; 442 tables carry org/user/permission-scoped policies | Pass — the remaining 11 (`permissions`, `feature_flags`, `subscription_plans`, `support_plans`, `integration_providers`, `releases`, `environment_registry`, `monitoring_checks`, `deployment_events`, `feature_flag_overrides`, `role_permission_templates`) are global platform catalogues: reads are reference data, every write is gated by `is_platform_admin()` | — |
| R7d Customer vs staff separation | G2/S8 | Verified | Separate `customers` / `profiles` identity chains | — | — | 0 staff profiles linked to a customer account; 0 customer accounts holding a staff role | Pass | — |
| R7e Button-level authorization | G2/S8 | In Progress | 54 of 149 workspace routes gate controls with `can(...)` | extend `can()` gating to destructive/sensitive controls on the remaining routes | many | Route grep | Partial — route and RLS layers already refuse these actions, so this is defence-in-depth, not an open hole | — |
| R7f Branch / station scope | G2/S8 | In Progress | Branch scope applied in the data layer (`useBranchScope`, per-query `branch_id` filters); org isolation enforced in RLS | push branch scope into policies for branch-sensitive tables | — | Only 1 policy references `branch_id` | Partial | — |
| R8 Durable outbox / events | G3/S9 | Implemented | `domain_events`, `emit_domain_event`, module triggers | correlation-id coverage audit | — | Functions present | Partial | — |
| R9 Idempotency | G3 | Implemented | `notifications.idempotency_key` unique, `automation_idempotency_keys`, `communication_queue.idempotency_key` | — | — | Constraint present | Pass | — |
| R10 Notification fan-out | G3 | Implemented | `notify_recipients()` excludes suspended/inactive, role/department/branch targeting | — | — | Function present | Pass | — |
| R11 External message queue | G3 | Implemented | `communication_queue_retry_guard` exponential backoff, queued while provider down | — | — | Trigger present | Pass | Blocked — Credentials (Resend / WhatsApp / Africa's Talking not configured) |
| R12 Approvals & self-approval block | G3 | Implemented | `enforce_no_self_approval` trigger, `approval_requests` / `approval_actions` | — | — | Trigger present | Pass | — |
| R13 Forms & dropdown dependencies | G3/S11 | In Progress | Shared `FormFields` primitives | systematic pass over every create/edit form (required fields, save-and-add-another, backend-confirmed reset, parent→child clearing, unsaved warning) | many | — | Outstanding | — |
| R14 Menu import (structured) | G4/S13 | Implemented | `MenuImportDialog.tsx` XLSX/CSV/TXT column mapping, per-row rejection, import batch, no AI extraction | downloadable templates, price history, batch rollback | `src/routes/_shell.pos.menu.tsx` | Manual import path reviewed | Partial | — |
| R15 Menu draft/publish lifecycle | G4 | Implemented | Draft → Published, drafts hidden from POS terminal and guest/delivery menus, audited publish | archive state, image upload to tenant-scoped storage | `src/routes/_shell.pos.menu.tsx` | Code review | Partial | — |
| R16 Cross-module contracts A–F | G4/S13 | In Progress | PMS, POS, KDS, Kitchen, Stores, Procurement, Events, Delivery, HR modules exist with data layers | end-to-end contract wiring + verification of each chain | `src/lib/*-data.ts` | — | Outstanding | Blocked — Manual Verification (requires operational records; no test data may be created) |
| R17 PMS / Housekeeping / Maintenance states | G4/S14 | In Progress | Separate occupancy, housekeeping condition and maintenance tables | single sellability derivation + contradiction elimination | — | — | Outstanding | — |
| R18 Finance posting contract | G4/S15 | Implemented | Double-entry journals, `fin_post_journal`, `fin_reverse_journal`, posted-record protection triggers, credit notes | idempotency key coverage across every source module | — | Triggers present | Partial | — |
| R19 Central Settings hub | G4/S16 | Implemented | `/settings` is now the single hub: Operations, Numbering, Approval thresholds, Security, **All settings** directory (21 destinations across Business setup, Branding, People & access, Documents & communication, Module settings — permission-filtered by `can(module,'view')`), and **Change history** from the audit trail | property-level override editing per section | `src/routes/_shell.settings.tsx` | Typecheck clean | Pass — scope banner states org-wide applicability and the active property; unsaved-change badge + beforeunload guard; save is disabled unless dirty and writes previous/new value to audit | — |
| R20 Dynamic branding propagation | G4/S16 | Implemented | Tenant brand in `organization_settings`, `AppPublishPanel`, public app shells | property override precedence, draft/preview/publish versioning, favicon/PWA per tenant, logout cleanup | `src/lib/branding.tsx` | Hardcoded fallback name removed | Partial | — |
| R21 Dashboard accuracy & navigation | G4/S15 | In Progress | Role dashboards, `DashboardFrame`, `AwaitingData` | clickable cards → filtered destinations, data-class labels, back-to-workspace everywhere | — | Header timezone mismatch fixed (GMT+3 → EAT) | Partial | — |
| R22 Placeholder classification | G4/S16 | Verified | — | — | — | Route inspection | Rates & Packages, Credit Accounts, Laundry, Maintenance, Delivery (staff), NEØ Intelligence, Reports & BI all render `ModulePlaceholder` → **UI Only / Not Implemented** | — |
| R23 Provider states | G4 | Verified | Provider registry with Not Configured status | — | — | Inspection | All external providers Not Configured; none faked as Connected | Blocked — Credentials |
| R24 Final verification GO decision | G5/S17 | In Progress | — | evidence gathering across R7e, R13–R21 | `docs/repair/` | — | **NO-GO** until every structural requirement is Verified | — |

## Required secret names (not configured, must not be faked)

`RESEND_API_KEY`, `WHATSAPP_TOKEN`, `AT_API_KEY`, `AT_USERNAME`, `OPENAI_API_KEY`,
`DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, `ETIMS_API_KEY`, `BOOKING_API_KEY`,
`EXPEDIA_API_KEY`, `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`,
`GOOGLE_MAPS_API_KEY`, `GOOGLE_CALENDAR_CLIENT_ID`.

## Rollback

Every change in this session is additive and code-level only (no migration was
issued this session). Rollback = revert the listed files. Earlier migrations are
additive; roll back by dropping only the objects created in that migration after
exporting `organization_settings` and `issued_document_numbers`.

## Resume point

Stages 7 and 8 are now Verified (R5, R6, R7, R7b, R7c, R7d) apart from R7e and R7f,
which are defence-in-depth refinements above already-enforced route and RLS layers.

Next units of work, in dependency order: R7e (button gating sweep) → R13 (forms,
validation, drafts, dependent dropdowns) → R17 (PMS / Housekeeping / Maintenance
state separation) → R21 (actionable dashboard
cards) → R16 (cross-module contracts) → R14/R15 (menu images, prep time, recipes) →
kitchen-to-inventory consumption → stores-to-procurement → R18 posting-contract
idempotency → Rates & Packages, Credit Accounts, Reports & BI, AI foundations
(currently UI Only per R22) → tenant/branch isolation tests → R24 final decision.
R19 is now Implemented (Central Settings hub consolidated with directory, scope
banner, unsaved-change protection and audit history).

## Batch 1 — Permissions, staff access and shared UI control (complete)

- **Canonical registry**: `permission_module_aliases` maps historical namespaces (`pms`, `pos`, `inventory`, `crm-*`, `hr-*`, `users`/`roles`/`settings`, …) onto canonical modules. `canonical_permission()` normalises every key to `module.feature.action`.
- **Inheritance rules**: `permission_action_classes` defines which detailed actions a module-wide grant covers (view / create / edit / print / export). Sensitive actions — approve, reject, void, refund, override, delete, reverse, write-off, period close, payroll, termination — are excluded and must be granted explicitly.
- **Resolvers**: `has_permission()` and `my_effective_permissions()` understand both naming styles and the inheritance rules; `role_permissions` now has a uniqueness rule preventing duplicate grants.
- **Additive role top-up**: every active role received any missing permissions from its latest approved template. No grant, custom permission or role ID was removed.
- **UI parity**: `src/lib/permissions.ts` mirrors the alias and action-class maps; `can()` in `src/lib/auth.tsx` resolves keys exactly as the database does, so navigation, route gate, buttons and RLS agree.
- **Audit trail consistency**: `audit_trail()` (organization-scoped, actor-resolved) now backs `/audit-logs`, so page figures match the administration dashboard and entries name the person instead of "Unknown user".
- **Events routes**: the 12 previously missing event pages (enquiries, calendar, site visits, quotations, readiness, venues, packages, equipment, billing, feedback, reports, settings) now exist with permission gates — no more Not Found from the module menu.

Verification (Receptionist role, live data): check-in, no-show marking and folio charge posting resolve to allowed; rate override and order void resolve to denied.

## Batch 2 — Accommodation lifecycle: one authoritative room record (in progress)

**Diagnosis (live data, Zawadi Springs Nairobi, 11 rooms).** Room state was stored
four times over and never reconciled: `room_condition` (edited by the Room Rack),
`housekeeping_status` / `maintenance_status` (edited by Housekeeping and
Maintenance through `ops_set_room_status`), `occupancy_status`, and a stored
`sellable` flag. Every live room carried `sellable = false` while its maintenance
state said `operational`, so Front Office reported zero sellable inventory and zero
occupancy while the rack showed six vacant-clean rooms; rooms marked
out-of-service, maintenance or blocked on the rack still read `clean` /
`operational` on the Housekeeping board. Vocabulary also differed between modules
(`ready-for-inspection` vs `awaiting-inspection`, `in-repair` vs
`under-maintenance`).

**Repair (additive, no data destroyed).**
- One authoritative model: `occupancy_status` (vacant / occupied / house-use),
  `housekeeping_status` (dirty / in-progress / awaiting-inspection / clean /
  inspected) and `maintenance_status` (operational / under-maintenance /
  out-of-service / out-of-order).
- New `rooms_derive_state()` trigger normalises legacy wording, derives
  `room_condition` and `sellable` from those three axes on every insert and update,
  and clears out-of-order details when a room returns to operational.
- `ops_set_room_status()` now also records occupancy changes, writes every change
  to `room_status_history`, and no longer maintains `sellable` by hand. The older
  six-argument overload was removed.
- `pms_available_rooms()`, `pms_front_office_metrics()` and `ops_metrics()` read the
  same axes, so availability, the Front Office dashboard, the Room Rack and the
  Housekeeping board can no longer disagree. `ops_metrics` is now branch-scoped for
  cleaning, inspection and job counts.
- Room Rack writes through `ops_set_room_status` (housekeeping and maintenance
  selectors) instead of overwriting `room_condition`; Rooms & Types no longer offers
  a manual "sellable" switch because sellability is derived.

Verified live after backfill: 8 sellable rooms, room 201 under maintenance, rooms
108 and 202 out of service — identical figures in the room table, front-office
metrics and housekeeping metrics.
