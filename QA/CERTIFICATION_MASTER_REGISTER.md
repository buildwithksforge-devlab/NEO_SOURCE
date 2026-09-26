# NEØ Hospitality OS — Certification Master Register

**Historical issue register, pending full reconciliation.** Last full register pass:
**2026-09-08 (pass 2)**. The targeted live recheck on **2026-09-25** below
supersedes conflicting rows; do not treat the older totals as current launch evidence.

### 25 September targeted live corrections

- RBAC-11: `outbox_reap_expired_leases`, `pms_escalate_overdue_requests`,
  `pms_expire_waitlist`, `pms_release_expired_blocks` all deny EXECUTE to
  `authenticated` and `anon` in the live database. The older OPEN claim is stale.
- RBAC-07: `neo_notify_event` and `neo_finance_ensure_account` deny authenticated
  EXECUTE; `neo_kitchen_reconcile_stations` and `neo_linen_incident_review` have
  permission checks. `neo_guest_deposit_pay` binds the reservation to the
  authenticated customer's ID. Do not label these an exploitable group based
  on the older regex scan. Review each remaining callable routine individually.
- INT-01: both `folios` and `purchase_orders` have live canonical sync triggers.
  Backfill is incomplete: 70/100 folios lack `folio` canonical records and
  3/28 purchase orders lack `procurement` canonical records. Finance review is
  required before touching historical balances or statuses.
- NOT-04: the published repository contains `src/lib/communication-providers.server.ts`
  with Resend, Africa's Talking, and WhatsApp sender adapters. Provider acceptance
  and actual receipt have not been demonstrated; the old “no outbound sender”
  claim is no longer accurate.
- Device push remains absent on the published revision. Local source now has a
  personal push path, pending migration, secret/scheduler configuration,
  deployment and real device verification. Department fan-out remains unbuilt.
- RBAC targeted fix: 16 authenticated-surface SECURITY DEFINER signatures had
  anonymous EXECUTE removed live; anon-callable count fell from 35 to 19.
  The manifest scan also uncovered a real `/kitchen/settings` break: the
  scoped `neo_station_store_readiness(uuid)` reader denied authenticated
  EXECUTE. The grant was restored and verified without anonymous access;
  an actual kitchen role screen test is still required.

Statuses: `FIXED` · `OPEN` · `BLOCKED BY OWNER DECISION` · `BLOCKED BY PROVIDER CONFIG` ·
`NEEDS LIVE ROLE TEST` · `NOT YET AUDITED`.
Severity: P0 (unsafe / blocks certification) · P1 (material) · P2 (hygiene).

A control existing in the interface is never sufficient for `FIXED`; persistence, server
enforcement or cross-role evidence is required. No status in this pass was carried over on the
word of an earlier audit — each was re-tested against current code or the live database.

> **Correction to the previous pass:** the previous "Total issues: 46" was an arithmetic error;
> the register actually contained 57 rows. No issue was lost. This pass adds 8 new findings for
> a true total of **65**.

---

## 1. Authentication, session, invitations

| ID | Sev | Issue | Evidence | User impact | Status | Fix / decision needed | Verification |
|---|---|---|---|---|---|---|---|
| AUTH-01 | P1 | Session teardown on sign-out and idle timeout | `src/lib/auth.tsx:198-225`, `:561-581` — clears query cache, tenant localStorage keys, sessionStorage, access cache, realtime channels | No data survives a sign-out | FIXED | — | Code review 2026-09-08 (pass 2) |
| AUTH-02 | P1 | Incomplete staff assignment must block access | `src/lib/auth.tsx:266-286`, `:422-433` — `suspended` / `no_account` / `setup_incomplete` map to blocking phases | Half-configured staff cannot act | FIXED | — | Code review 2026-09-08 |
| AUTH-03 | P2 | Reset page does not confirm a recovery-type session and does not end other sessions | `src/routes/auth.reset-password.tsx:40` — relies on implicit `supabase.auth.updateUser` behaviour | Password can be changed outside the reset flow; old sessions survive | OPEN | Assert recovery-type session; revoke other sessions | Source re-read 2026-09-08 (pass 2) |
| AUTH-04 | P2 | Password reset writes no audit entry | `src/routes/auth.reset-password.tsx:48` — no `audit_logs` write in the route | Password changes invisible to auditors | OPEN | Add audit write | Source re-read 2026-09-08 (pass 2) |
| AUTH-05 | P2 | Invitation replay / expiry not proven | `src/lib/users.functions.ts:109-126`, `:520` | A claimed invitation might be re-armed | NEEDS LIVE ROLE TEST | Live invite → claim → replay attempt | — |

## 2. RBAC — server and database enforcement

| ID | Sev | Issue | Evidence | User impact | Status | Fix / decision needed | Verification |
|---|---|---|---|---|---|---|---|
| RBAC-01 | P0 | Till close / movement had no database permission check | `cash_close_shift`, `cash_record_movement` contain `has_permission('restaurant','shifts',…)` | Any signed-in user could close a till | FIXED | — | Live `pg_proc` definition scan 2026-09-08 (pass 2): guarded = true |
| RBAC-02 | P0 | Guest-request assign / complete / feedback had no database check | `pms_request_assign`, `pms_request_complete`, `pms_request_feedback` | Anyone could reassign or close guest requests | FIXED | — | Live `pg_proc` scan (pass 2): guarded = true for all three |
| RBAC-03 | P0 | Supplier-invoice matching had no capability check | `proc_three_way_match` calls `neo_assert_capability('procurement','invoices','manage')` | Any staff could force an invoice to matched | FIXED | — | Live `pg_proc` scan (pass 2): guarded = true |
| RBAC-04 | P0 | Shortage → purchase request had no capability check | `neo_stores_shortage_to_pr` requires `stores.requisitions.create` | Any staff could raise procurement demand | FIXED | — | Live `pg_proc` scan (pass 2): guarded = true |
| RBAC-05 | P0 | Cash transfer send/cancel and refund payout had no capability check | `neo_cash_transfer_send`, `neo_cash_transfer_cancel`, `neo_cash_refund_settle` | Cash moved/refunded without cashier authority | FIXED | — | Live `pg_proc` scan (pass 2): guarded = true for all three |
| RBAC-06 | P0 | Internal posting routines directly callable by any signed-in user | Live privilege check (pass 2): `neo_financial_state_set`, `neo_evaluate_low_stock`, `neo_finance_reverse_posting`, `neo_grn_post_accrual`, `neo_event_post_payment`, `neo_gl_period` — `authenticated` EXECUTE = **false** | A signed-in user could post or reverse journals | FIXED | — | `has_function_privilege('authenticated', …)` = false for all six, 2026-09-08 (pass 2) |
| RBAC-07 | P1 | SECURITY DEFINER writes still callable by any signed-in user with **no capability check** | Live check (pass 2), `authenticated` EXECUTE = true and no `has_permission`/`neo_assert_capability` in the body: `pkg_allocate_folio_line`, `neo_guest_deposit_pay`, `neo_report_defect`, `neo_kitchen_reconcile_stations`, `neo_linen_incident_review`, `neo_canonical_transaction_set` (workspace-guarded only) | Privilege escalation inside a workspace: folio allocation, guest deposits, station remapping | OPEN | Add `neo_assert_capability` per action, using the capability each role template already grants | Live definition + privilege scan 2026-09-08 (pass 2) |
| RBAC-08 | P2 | `can_manage_workforce()` lets a user-inviting admin rewrite any role's permissions (`set_role_permissions`, `apply_recommended_permissions`) | Wrapper definition | Broad, silent permission rewrites | BLOCKED BY OWNER DECISION | Decide whether "manage roles" is separate from "invite users" | — |
| RBAC-09 | P2 | Stale legacy role rows still active with sparse permissions | `public.roles` | Staff could be assigned an under-permissioned duplicate | BLOCKED BY OWNER DECISION | Owner confirms which legacy roles to archive (no automatic deletion) | — |
| RBAC-10 | P0 | **NEW.** The full privileged surface is far larger than the five routines previously reviewed | Live census 2026-09-08 (pass 2): **564** callable non-trigger SECURITY DEFINER functions; **276** detected as writers; **207** writers contain an authorisation marker; **69** writers contain **none**; **38** of those also contain no workspace marker; **23** accept a caller-supplied `_org`/`_organization` argument with no mismatch guard; **1** is callable anonymously | Unknown residual privilege-escalation and cross-workspace write risk; cannot be certified by sampling | OPEN | Classify all 69 by intent (internal / cron / guest-owned / staff-facing), then revoke EXECUTE or add capability + workspace guards. Highest-risk named so far: `neo_apply_feature_templates`, `neo_finance_ensure_account`, `neo_install_default_workflows`, `neo_bump_access_epoch`, `neo_approval_execute`, `neo_autoseed_role_aliases`, `provision_catalogue_roles`, `seed_dashboard_catalogue`, `inventory_consume_order_item_core`, `neo_notify_event` | Live `pg_proc` census + targeted definition reads 2026-09-08 (pass 2). Regex census is a discovery heuristic, not proof of exploitability |
| RBAC-11 | P1 | **NEW.** Scheduled maintenance routines are also callable by any signed-in user | `cron.job` (live): `neo-outbox-process`, `neo-release-blocks`, `neo-expire-waitlist`, `neo-escalate-requests`, `neo-integrity-checks` are all active; the underlying `pms_release_expired_blocks`, `pms_expire_waitlist`, `pms_escalate_overdue_requests`, `outbox_reap_expired_leases` grant EXECUTE to `authenticated` | A staff user could force-run workspace-wide maintenance out of band | OPEN | Revoke EXECUTE from `authenticated`/`anon`; keep `service_role` (cron runs as superuser, so cron is unaffected) | Live `cron.job` + privilege check 2026-09-08 (pass 2) |

## 3. Tenant and property isolation

| ID | Sev | Issue | Evidence | User impact | Status | Fix / decision needed | Verification |
|---|---|---|---|---|---|---|---|
| TEN-01 | P0 | Feature-flag overrides readable across workspaces | Live `pg_policies` (pass 2): `feature_flag_overrides_read` = `is_platform_admin() OR (organization_id = current_org_id())`; write = `is_platform_admin()` | Config leak between customers | FIXED | — | Live policy read 2026-09-08 (pass 2) |
| TEN-02 | P0 | Canonical state write accepted any workspace ID | `neo_canonical_transaction_set` raises on a mismatched workspace | Cross-tenant record writes | FIXED (workspace only — see RBAC-07 for the missing capability check) | — | Live function source 2026-09-08 (pass 2) |
| TEN-03 | P2 | Platform catalogue tables read `USING (true)` (permissions, role templates, plans, releases) | Generic policy loop | None today — no workspace column | FIXED (by design) | Revisit if any gains a workspace column | Policy review |
| TEN-04 | P1 | Not every `purchase_orders` / `folios` client query proven to pass through the shared property filter | `src/lib/procurement-data.ts:43,464` | A screen could show another property's figures | NEEDS LIVE ROLE TEST | Per-call-site sweep plus a non-owner role check | — |

## 4. Persistence

| ID | Sev | Issue | Evidence | Impact | Status | Fix | Verification |
|---|---|---|---|---|---|---|---|
| PER-01 | P1 | Hardcoded `owner` role in the session module | Removed from `src/lib/session.tsx` | Role could be assumed rather than derived | FIXED | — | Code review |
| PER-02 | P2 | Browser storage used for density, view presets, active property, preview mode | `density.ts`, `view-presets.ts`, `property-selection.ts`, `preview-mode.ts` | Preference caches only; the server still filters by workspace | FIXED (by design) | — | Policy review |
| PER-03 | P2 | No mock/demo/seed data path in the staff app | Repo sweep | — | FIXED | — | Sweep 2026-09-08 |

## 5. Cross-role workflows

| ID | Sev | Chain | Live evidence | Status | Notes |
|---|---|---|---|---|---|
| FLW-01 | P0 | Reservation → check-in → room → folio | Live rows join end to end | FIXED | — |
| FLW-02 | P0 | POS order → kitchen ticket → ready → served | 50 linked live rows across all states; ready event fires once | FIXED | — |
| FLW-03 | P1 | Served → charge to room → payment | `pos_post_room_charge` sets `payment_status` in the **same transaction** as the folio line insert (`supabase/migrations/20260812181742_…:880`) | FIXED | The single stale unpaid row is now tracked separately as INT-05 |
| FLW-04 | P1 | POS/folio → finance journal | `journal_entries`: pos 187, folio 209, pms 7, procurement 7 | FIXED | Room-charge journals not separately distinguishable |
| FLW-05 | P1 | Recipe → consumption → requisition → PO → GRN → stock | Tables and routines present; **no live record traced end to end**, and the chain cannot run today (see OPS-01) | NEEDS LIVE ROLE TEST | Blocked in practice by OPS-01 |
| FLW-06 | P2 | Housekeeping recovery task | Job type allowed and UI shipped; zero live recovery rows | NEEDS LIVE ROLE TEST | — |
| FLW-07 | P1 | Events / BEO / billing | Not re-traced this pass | NEEDS LIVE ROLE TEST | — |
| FLW-08 | P1 | Guest booking, guest delivery/pickup → POS/KDS | Booking proven earlier (`RES-2609-CA52`); delivery→KDS routing not re-proven live | NEEDS LIVE ROLE TEST | — |

## 6. Notifications and external providers

| ID | Sev | Issue | Evidence | Impact | Status | Needed |
|---|---|---|---|---|---|---|
| NOT-01 | P0 | In-app notifications must not depend on providers | 271 live `notifications` rows, written by database routines and app code; no provider involvement | Staff alerts work regardless of email/SMS | FIXED | — |
| NOT-02 | P0 | No email/SMS/WhatsApp can be delivered | Live: `communication_queue` = **0 rows ever**, `communication_delivery_events` = 0, `mpesa_settings` with a short code = 0 | Guests receive no confirmations or receipts | BLOCKED BY PROVIDER CONFIG | Real provider credentials from the owner |
| NOT-03 | P1 | Provider connections show "connected" without any sending capability | Live `provider_connections`: email 2 connected / 1 not_configured, sms 2 connected / 1 not_configured, whatsapp 3 not_configured, ai 2 connected | Misleading readiness signal | OPEN | Show "not sending" until a real send succeeds |
| NOT-04 | P0 | **NEW.** No outbound sender exists in the codebase at all | `src/lib/automation-engine.server.ts:648-649` — comment states dispatch "is performed by the provider integration layer"; that layer does not exist. Repo sweep found no HTTP call to any email/SMS/WhatsApp provider | Even with credentials, nothing would send. This is an engineering gap, not only a credential gap | OPEN | Build the sender per channel behind the existing queue and failure-code contract |
| NOT-05 | P1 | **NEW.** The communication/automation engine is never scheduled | `runAutomationEngine` is only invoked from a button in `src/routes/_shell.automation.index.tsx:71`; no `cron.schedule` entry exists for it (live `cron.job` lists only outbox, blocks, waitlist, escalations, integrity) | Queued messages and escalations only progress when someone clicks | OPEN | Schedule the engine once a sender exists |

## 7. Data integrity and lifecycle

| ID | Sev | Issue | Evidence | Impact | Status | Needed |
|---|---|---|---|---|---|---|
| INT-01 | P0 | `folios.status` and `purchase_orders.status` never reach `canonical_transaction_states` / `financial_states` | Live `pg_trigger`: `canonical_state_sync` exists only on `event_bookings, goods_receipts, internal_requisitions, maintenance_work_orders, payments, pos_orders, reservations, rooms, supplier_invoices, supplier_payments` — folios and purchase orders are absent. Source: `supabase/migrations/20260831092017_…:163-201`. Live scale: 81 folios and 3 purchase orders vs 116 canonical rows with no `folio` or `purchase_order` source module | Finance/canonical views can show a folio or PO as pending forever while the module shows it closed | OPEN | Add both to the sync trigger with explicit mapping cases; derive, never duplicate. No data deletion |
| INT-02 | P1 | `pos_orders.status` — single derived source, guarded | `neo_pos_lifecycle_guard()` + canonical sync trigger (trigger confirmed live) | Correct | FIXED | — |
| INT-03 | P1 | Idempotency proven only for the canonical writer and the M-Pesa/receipt paths | `UNIQUE (organization_id, idempotency_key)` + advisory lock | Other money routines unproven | OPEN | Sweep remaining money-moving routines for an idempotency key |
| INT-04 | P2 | `feature_flag_overrides.organization_id` nullable by design | Schema | Global vs tenant rows share a table | FIXED (scoped by policy) | — |
| INT-05 | P2 | **NEW.** One legacy POS order is charged to a folio while still marked unpaid | Live: `POS-20260827-PIWG0` — `status='charged-to-room'`, `payment_status='unpaid'`, folio `8e1bd0c9…`. The other charged-to-room order is `credit`, which is correct | A single historic order misreports as unsettled | OPEN | Owner/finance review of that one record; the write path itself is now atomic (FLW-03). No bulk correction performed |
| INT-06 | P1 | **NEW.** `financial_states.module` uses inconsistent keys for the same concept | Live distinct values include both `pos` and `pos_order`, `supplier_invoice` and `supplier-invoice`, `delivery` and `delivery_order`, `inventory` and `inventory-receipt`, `laundry` and `laundry_order` | Finance roll-ups split one module into two buckets, understating each | OPEN | Adopt one key per module and adapt readers; no row deletion |

## 8. Realtime scoping

| ID | Sev | Issue | Evidence | Status |
|---|---|---|---|---|
| RT-01 | P0 | Live updates were not filtered by workspace | `src/lib/realtime-scope.ts:19-46` adds a per-workspace channel and `organization_id` filter; all six subscribers use it (`dashboard-data.ts:456`, `operations-data.ts:1358`, `kitchen-data.ts:1063`, `pos-data.ts:288`, `kitchen-tickets.ts:260`, `kitchen-alerts.ts:92`); no other channel exists | FIXED (re-verified 2026-09-08 pass 2) |

## 9. CRUD, dashboards and reports

| ID | Sev | Issue | Evidence | Status | Needed |
|---|---|---|---|---|---|
| CRD-01 | P1 | HR screens property-scoped | `src/lib/hr-data.ts` uses the shared property filter at all checked call sites | FIXED | — |
| CRD-02 | P1 | Finance screen property scoping | Re-checked (pass 2): `src/lib/finance-data.ts` **does** apply the shared branch filter via `applyTo`. `src/lib/finance.ts` remains unswept | OPEN | Complete the sweep of `src/lib/finance.ts` call sites |
| CRD-03 | P1 | Dashboard "loading vs zero" correctness only spot-checked | — | NEEDS LIVE ROLE TEST | Non-owner role pass over each dashboard |
| CRD-04 | P1 | **NEW.** Approval-rule queries are not property-scoped | `src/lib/finance-controls.ts:419,437` — `approval_rules` read without a branch filter | A property's approval thresholds can be read/applied across properties | OPEN | Apply the shared property filter |

## 10. Inventory hierarchy

| ID | Sev | Issue | Evidence | Status | Needed |
|---|---|---|---|---|---|
| INV-01 | P1 | No Item Group level existed above categories | `public.stock_item_groups` (workspace-scoped, RLS) and optional `stock_categories.group_id` | FIXED | — |
| INV-02 | P1 | Owner mapping interface | Stock items screen has an **Item groups** tab; each category can be assigned to a group (`src/routes/_shell.inventory.items.tsx:60-176`) | FIXED | — |
| INV-03 | P1 | The taxonomy is empty and all categories are unmapped | Live (pass 2): `stock_item_groups` = **0**, `stock_categories` = 49 with **49** unmapped, `stock_items` = 116 | BLOCKED BY OWNER DECISION | Owner defines the groups and maps the 49 categories. Nothing is assigned automatically |
| INV-04 | P2 | Stores remain separate physical locations | `stock_locations` (25 live rows) untouched | FIXED (by design) | — |

## 11. Guest documents

| ID | Sev | Issue | Evidence | Status | Needed |
|---|---|---|---|---|---|
| DOC-01 | P0 | No secure storage existed for guest documents | Live: bucket `guest-documents`, `public = false`, 25 MB limit; paths `workspace/guest/file` | FIXED | — |
| DOC-02 | P0 | Access rules | `customer_documents` split into view/create/edit/delete policies on `crm.documents` capabilities plus a guest's own documents; storage policies mirror them | FIXED | — |
| DOC-03 | P1 | Profile interface | Documents tab wired at `src/routes/_shell.crm.customers.$id.tsx:879`; `src/lib/guest-documents.ts` uses the private bucket (`:15`), signed URLs (`:120`) and access logging (`:108`) | FIXED | — |
| DOC-04 | P1 | Access accountability | `customer_document_access_log` exists with RLS; live rows = 0 (nothing uploaded yet) | FIXED | — |
| DOC-05 | P2 | Who may see guest documents, and retention | Live: `crm.documents` capabilities are granted to **0 roles**; only Owner/System Administrator reach them through superuser parity. `customer_documents` = 0 rows | BLOCKED BY OWNER DECISION | Owner assigns the capability to the intended roles and sets a retention rule |

## 12. M-Pesa

| ID | Sev | Issue | Evidence | Status | Needed |
|---|---|---|---|---|---|
| MPE-01 | P1 | Credential boundary | Credentials read server-side only, never returned to the browser | FIXED | — |
| MPE-02 | P1 | Callback safety and idempotency | Per-tenant callback token, workspace lookup, unique `checkout_request_id`, acknowledgement even on no-match | FIXED (code); live leg depends on MPE-03 | — |
| MPE-03 | P0 | Nothing has ever been transacted | Live: `mpesa_transactions` = 0; `mpesa_settings` rows with a short code = **0** | BLOCKED BY PROVIDER CONFIG | Property short code, key, secret, passkey and a reachable callback address |
| MPE-04 | P1 | No automatic reconciliation of stuck payments | No scheduler entry exists in live `cron.job` | OPEN | Add scheduled reconciliation once a provider is live |

## 13. Permission templates by department

| ID | Sev | Issue | Evidence | Status | Needed |
|---|---|---|---|---|---|
| TPL-01 | P1 | Chef, Bar Manager, Restaurant Manager have stores view but no requisition action | `role_permission_templates` | BLOCKED BY OWNER DECISION | Rule says F&B Manager, Restaurant Manager, Coffee Station Supervisor may requisition — owner confirms Chef and Bar Manager |
| TPL-02 | P1 | Night Auditor has general-ledger view only | `role_permission_templates` | BLOCKED BY OWNER DECISION | Confirm whether Night Audit posts end-of-day journals |
| TPL-03 | P1 | Action-level server enforcement per role not exercised with real accounts | — | NEEDS LIVE ROLE TEST | One live account per department |
| TPL-04 | P1 | Operations Manager oversight, escalations and 15% discount ceiling | Templates reflect the rule | FIXED | Re-test live when accounts exist |

## 14. Station, store and recipe routing

| ID | Sev | Issue | Evidence | Status | Needed |
|---|---|---|---|---|---|
| OPS-01 | P1 | **NEW.** The kitchen consumption chain is fully built but entirely unconfigured | Live (pass 2): 109 operational stations, 25 stock locations, **0** locations bound to a station (`stock_locations.station_id`), so **0 stations have a consumption store**; 63 recipes with **1** carrying a station; 69 routing rules exist. Configuration UI verified present (`src/lib/kitchen-data.ts:1211` `useConsumptionStores`; recipe station picker `src/lib/recipe-master.ts:126,339`) | BLOCKED BY OWNER DECISION | Owner assigns each station its issuing store and each recipe its station. Nothing may be inferred; until then FLW-05 cannot be certified |

---

## Reconciliation — prior issue → status this pass

| Prior ID | Prior status | Status now | Basis for the change |
|---|---|---|---|
| AUTH-01/02 | FIXED | FIXED | Re-read source |
| AUTH-03/04 | OPEN | OPEN | Confirmed still missing in `auth.reset-password.tsx` |
| AUTH-05 | NEEDS LIVE ROLE TEST | unchanged | No live account |
| RBAC-01…05 | FIXED | FIXED | Live definition scan: guard present in each |
| RBAC-06 | FIXED | FIXED | Live privilege scan: `authenticated` EXECUTE false on all six |
| RBAC-07 | OPEN | OPEN (list corrected) | Live scan confirmed 5 named routines still open; `neo_laundry_batch_*` and `neo_group_record_deposit` not reproducible under those names |
| RBAC-08/09 | OWNER | unchanged | — |
| TEN-01/02 | FIXED | FIXED | Live policy and function source |
| TEN-03/04 | FIXED / NLRT | unchanged | — |
| PER-01…03 | FIXED | unchanged | — |
| FLW-01/02/04 | FIXED | unchanged | — |
| FLW-03 | OPEN | **FIXED** | `pos_post_room_charge` proven atomic; residual row split out as INT-05 |
| FLW-05…08 | NLRT | unchanged (FLW-05 now also blocked by OPS-01) | — |
| NOT-01 | FIXED | FIXED | 271 live rows, provider-independent |
| NOT-02 | PROVIDER | unchanged | Queue still 0 rows |
| NOT-03 | OPEN | OPEN | Live: 4 channels report "connected" with no sender |
| INT-01 | OPEN | OPEN | Live trigger list proves both tables excluded |
| INT-02/04 | FIXED | unchanged | — |
| INT-03 | OPEN | unchanged | — |
| RT-01 | FIXED | FIXED | All six subscribers re-checked |
| CRD-01 | FIXED | unchanged | — |
| CRD-02 | OPEN | OPEN (narrowed) | `finance-data.ts` is scoped; `finance.ts` is not swept |
| CRD-03 | NLRT | unchanged | — |
| INV-01…04 | FIXED / OWNER | unchanged | Live counts confirm 0 groups, 49 unmapped |
| DOC-01…05 | FIXED / OWNER | unchanged | Bucket confirmed private; capability granted to 0 roles |
| MPE-01…04 | FIXED / PROVIDER / OPEN | unchanged | 0 short codes configured |
| TPL-01…04 | OWNER / NLRT / FIXED | unchanged | — |

## New discoveries this pass

RBAC-10 (P0), RBAC-11 (P1), NOT-04 (P0), NOT-05 (P1), INT-05 (P2), INT-06 (P1), CRD-04 (P1), OPS-01 (P1).

## Counts (2026-09-08, pass 2)

- **Total issues: 65**
- P0: 19 · P1: 33 · P2: 13
- **FIXED: 33**
- **OPEN: 15** — AUTH-03, AUTH-04, RBAC-07, RBAC-10, RBAC-11, NOT-03, NOT-04, NOT-05, INT-01, INT-03, INT-05, INT-06, CRD-02, CRD-04, MPE-04
- **BLOCKED BY OWNER DECISION: 7** — RBAC-08, RBAC-09, INV-03, DOC-05, TPL-01, TPL-02, OPS-01
- **BLOCKED BY PROVIDER CONFIG: 2** — NOT-02, MPE-03
- **NEEDS LIVE ROLE TEST: 8** — AUTH-05, TEN-04, FLW-05, FLW-06, FLW-07, FLW-08, CRD-03, TPL-03
- **NOT YET AUDITED: 0**

## Remaining blockers to final certification

1. **Engineering (15 open items).** Largest is RBAC-10: 69 privileged write routines carry no authorisation marker and 38 no workspace marker — each must be classified and either locked down or guarded. Then INT-01 (folio/PO never reach the canonical view), INT-06 (split finance module keys), NOT-04/NOT-05 (no sender, no schedule), RBAC-07/RBAC-11, CRD-02/CRD-04, AUTH-03/04, INT-03, INT-05, MPE-04.
2. **Owner decisions (7).** Item-group taxonomy and mapping of 49 categories; station→store and recipe→station assignments (109 stations, 0 configured); who may see guest documents and for how long; Chef/Bar Manager requisition rights; Night Audit journal posting; legacy role archival; separating "manage roles" from "invite users".
3. **Provider configuration (2).** No email/SMS/WhatsApp credentials; no M-Pesa short code on any property.
4. **Live role accounts (8).** One working account per department to certify action-level enforcement, the recipe→procurement→stock chain, events billing, guest delivery routing and dashboard correctness for non-owner users.

## Verification performed this pass (read-only)

- Live `pg_proc` census of all callable SECURITY DEFINER functions, plus targeted definition and EXECUTE-privilege checks on 23 named routines.
- Live `pg_policies` read for `feature_flag_overrides`; live `pg_trigger` read for `canonical_state_sync`.
- Live `cron.job` inventory; live counts for notifications (271), communication queue (0), delivery events (0), domain events (1382 processed / 0 failed), M-Pesa transactions (0), canonical states (116), folios (81), purchase orders (3), item groups (0), unmapped categories (49), stock items (116), guest documents (0), document access log (0), stations (109), station-bound stores (0), recipes with a station (1 of 63).
- Source reads: `automation-engine.server.ts`, `auth.reset-password.tsx`, `finance-controls.ts`, `guest-documents.ts`, `kitchen-data.ts`, `recipe-master.ts`, `realtime-scope.ts`, `_shell.inventory.items.tsx`, `_shell.crm.customers.$id.tsx`, migration `20260812181742…` and `20260831092017…`.
- **No code, schema, policy, privilege or operational data was changed in this pass.**

## Update — inventory hierarchy, store routing and the shared register

Changes made after the read-only pass above. Prior findings and IDs are unchanged.

| ID | Change | Evidence | New status |
| --- | --- | --- | --- |
| INV-03 | Seven item groups created and **all 49 categories placed** (Food/Dry Goods 22, Beverage 10, General 6, Maintenance 4, Cleaning & Chemicals 3, Guest Amenities 2, Linen & Laundry 2); 0 unmapped. Owner authorised the mapping in conversation. | Live `stock_categories.group_id` count by group | FIXED |
| INV-04 (new) | One default store per group per property — **28 group→store links** across Savannah Crown Mombasa/Nairobi/Taveta and Serene Escape Nairobi. | Live `stock_group_stores` | FIXED |
| INV-05 (new) | Sale consumption now takes each ingredient from its group's store for that property; a station's own store still wins, legacy branch resolution remains the last fallback. Store used is recorded on the posting event (`station_location_id`, `group_routed_lines`). | `inventory_consume_order_item_core`, `neo_item_group_store` | FIXED |
| INT-01 | `folios` and `purchase_orders` now sync into the canonical register via triggers; **existing rows are not backfilled** — they join as they are next touched. | `neo_canonical_source_sync` triggers | PARTIALLY FIXED |
| FIN-01 (new) | Shared transaction register page at `/finance/register`: canonical records grouped by day, totals for recorded / in the ledger / awaiting posting / needs attention, filters by source and money position. Gated on `finance.reconciliation`. | `src/routes/_shell.finance.register.tsx` | FIXED |
| RBAC-12 (new) | 598 SECURITY DEFINER routines remain executable by any signed-in user (linter 0029). Two internal routines (`neo_item_group_store`, `inventory_consume_order_item_core`) were revoked this pass. | Supabase linter | OPEN |
| FLW-05 | Recipe → station → store chain: configuration path and store routing now exist end to end in code, but **no live sale has been run** through it. | — | NEEDS LIVE ROLE TEST |
| MPE-03 | Unchanged. No property short code or provider credentials exist, so initiation/callback cannot be exercised or reconciled against a real payment. | Live `mpesa_settings` | BLOCKED BY PROVIDER CONFIG |

Verification: `tsgo --noEmit` clean; RPC manifest tests pass.

## Security-definer & guest-document verification pass (this session)

All previously recorded issue IDs and statuses above remain valid; nothing was removed.

### Guest documents — VERIFIED (storage + policy layer), NEEDS LIVE ROLE TEST (end-to-end)
- Bucket `guest-documents` is private (`public = false`); `avatars` and `menu-images` are private too. No public URL path exists in code.
- storage.objects SELECT requires path segment 1 = `current_org_id()` AND (CRM documents/view capability OR the signed-in guest's own customer folder). INSERT requires CRM documents/create; DELETE requires CRM documents/delete.
- `customer_documents` RLS: staff need current-org + the matching CRM document capability; a guest sees only their own linked customer's rows.
- `customer_document_access_log`: read requires CRM documents/view in the org; insert requires `actor_id = auth.uid()`.
- `src/lib/guest-documents.ts` issues 60-second signed URLs and writes a `view` log before returning the URL; deletes log first, then remove metadata + object.
- STILL OPEN: no live cross-guest / cross-tenant / receptionist / Finance / random-authenticated download attempts have been executed. Requires role sessions.

### SECURITY DEFINER inventory — evidence
- 608 non-trigger SECURITY DEFINER routines; 566 callable by `authenticated`; 1 callable by `anon` (`neo_public_menu(_org,_branch,_fulfilment)`, read-only menu).
- 329 heuristic writers; 296 of those callable by `authenticated`.
- 37 authenticated writer candidates lacked capability/org markers; refined scan (auth.uid()/scope markers) reduced this to 18.

### Fixes applied this session (additive, no business rules changed)
- EXECUTE revoked from PUBLIC/anon/authenticated (service_role only) on 12 internal routines whose only callers are other SECURITY DEFINER routines or cron jobs:
  `neo_approval_execute`, `neo_autoseed_role_aliases`, `neo_bump_access_epoch`, `neo_install_default_workflows`,
  `neo_provisioning_step`, `outbox_reap_expired_leases`, `pms_escalate_overdue_requests`, `pms_expire_waitlist`,
  `pms_release_expired_blocks`, `pos_recalc_order_totals`, `provision_catalogue_roles`, `seed_dashboard_catalogue`.
- Cross-tenant guards added (raise 42501 when a signed-in caller supplies another organisation):
  `neo_finance_ensure_account`, `neo_kitchen_alert`, `neo_notify_event`, `neo_kitchen_aggregate_ticket` (guards on the ticket's own org).
- `neo_apply_feature_templates` now requires `current_org_id()` match AND `is_org_admin_for(_org)`.
- `neo_kitchen_alert` deliberately keeps authenticated EXECUTE: it is called by the SECURITY INVOKER routine `neo_kitchen_bulk_ticket_transition`. It is now org-guarded instead of revoked.
- `neo_guest_deposit_pay` re-read: already ownership-checked via `my_customer_id()` + reservation match + configured short code; no change needed.

### Remaining status
- Signed-in EXECUTE on SECURITY DEFINER routines: 586 linter warnings remain (down from 599). Most are org/capability-guarded internally; a routine-by-routine sweep of the remaining authenticated writers is still OPEN.
- Cashier / Receptionist / Waiter / Chef / Storekeeper / Procurement / Housekeeper / Maintenance / Events / Finance / HR / Guest and custom-role matrices: NEEDS LIVE ROLE TEST.
- Tenant/branch isolation (read, write, realtime, documents, RPC): NEEDS FINAL SECURITY TESTING with two live sessions in different organisations.
- M-Pesa: BLOCKED BY PROVIDER CONFIG (no property short code / credentials).

## Authoritative financial lifecycle (this session)

**FIXED — competing transaction-state models unified for reading.**
- New `public.neo_financial_lifecycle_register(_branch,_from,_to,_family,_status)` matches
  `canonical_transaction_states` to `financial_states` per transaction using
  `neo_financial_family()` (which reconciles the differing module spellings: `pos`/`pos_order`,
  `supplier-invoice`/`supplier_invoice`, `inventory-receipt`/`inventory`, `event_*` → `event`, etc.).
- Precedence is explicit and documented: the **accounting record owns the financial status**
  (it owns the journal), the **canonical record owns the operational status** (it owns the workflow).
  Operational and financial vocabularies are never translated into each other.
- Where the two records hold different financial statuses the row carries `disagreement = true`
  and the canonical value alongside; nothing is silently reconciled.
- Scoping: the register returns only `current_org_id()`, and for users whose
  `current_access_scope()` is not `all`, only branches in `current_branch_ids()`.
- Front end: `src/lib/financial-lifecycle.ts` (`useFinancialLifecycle`, `summariseLifecycle`),
  consumed by `/finance/register`, which now shows a "Records disagreeing" figure, a
  disagreement filter and a per-row flag.

**Live baseline at time of writing** (matched on org + family + source id):
- 49 transactions present in both registers
- 420 present only in the accounting register
- 77 present only in the canonical register
- **12 transactions where the two registers disagree on the financial status** — these are now
  visible in Finance instead of being invisible. Each needs owner/finance triage; the cause per
  row is not assumed here.

### Still NEEDS VERIFICATION / LIVE TEST (unchanged, no credentials supplied)
- Dashboard-changes-with-a-real-transaction proof, per organisation and property.
- Finance chain proof (payment → state → posting → reconciliation → refund/void → audit) with a
  live finance session, including duplicate-payment, duplicate-posting, unauthorised refund and
  unauthorised discount attempts.
- HR org/branch/department/role scoping proof with a live HR session.
- System-wide persistence proof (no local/mock state, cross-role retrieval, survives refresh).
- M-Pesa: BLOCKED — no real short code supplied.
- Cashier / receptionist / waiter walkthroughs: BLOCKED — no account emails supplied.
- Recipe → station → store live kitchen run: BLOCKED — recipe/station/store not nominated.

## Cross-role chain certification — 2026-09-08 (live evidence, read-only)

Eleven chain invariants were run against the live database and encoded as a
repeatable suite in `src/lib/__tests__/live-cross-role-chains.test.ts`
(skipped unless `PGHOST` is set). Break counts at time of run:

| # | Chain invariant | Broken records | Status |
|---|---|---|---|
| A | Arrived/departed stay carries a folio | 0 | PASS |
| B | Departed stay leaves no open folio with a balance | **8** | OPEN (P1) |
| C | Live sale with items reaches a station ticket | **123** (all 10–23 Aug, pre-routing-fix) | OPEN — historical backlog only; no break after 24 Aug |
| D | Room-charged sale lands on the guest folio | 0 | PASS |
| E | Requisition shortage raises a purchase request | 0 | PASS |
| F | Accepted goods receipt is posted to Finance | 0 | PASS |
| G | Completed job needing inspection is not called clean | 0 | PASS |
| H | Active work order has a named technician | **7** | OPEN (P1) |
| I | Closed work order was verified | 0 | PASS |
| J | Confirmed/completed event has a banquet event order | **9 of 10** | OPEN (P0 for Events chain) |
| K | Completed event is billed | 0 | PASS |

Volume baseline: 118 reservations (24 checked-in, 57 checked-out), 81 folios,
253 folio lines, 236 POS orders, 50 station tickets, 4 internal requisitions,
3 purchase orders, 5 goods receipts (all posted), 96 housekeeping jobs (all with
a source record), 26 work orders (22 with no assignee overall), 10 event
bookings, 1 banquet event order, 10 billing items, 11 event payments.

Reading: Stores, Housekeeping and the money-side of PMS/Restaurant hold as
chains. The unproven handoffs are Events (operations never receives a banquet
order for 9 confirmed events), Maintenance (work sits without an owner) and
departure settlement (8 departed guests left an open balance). Restaurant
routing is sound going forward; the 123 unrouted sales are a pre-fix backlog.

Role-experience certification (cashier/receptionist/waiter walkthroughs) is
still outstanding and still needs real accounts.

## Simulation run 2609091038-12EF (latest)

- 88 checks: 85 passed, 3 warnings, 0 failures, 0 critical, 0 skipped.
- Both isolated TEST workspaces provisioned and purged; cleanup verified, no leftovers, no stored credentials.
- FIXED: waiters could edit the restaurant menu. Three provisioning routines
  (`provision_catalogue_roles`, `neo_apply_role_templates`, `apply_recommended_permissions`)
  expanded area-wide template lines such as `restaurant.create` into every feature,
  including `menu` and `settings`. All three now exclude catalogue/configuration
  features unless the template names them explicitly; existing waiter grants were
  cleaned. Ordering, billing and service rights are unchanged.
- Remaining warnings (all honest, none are core failures):
  1. Events billing — the test event carries no priced package, so no billing lines.
  2. External messaging — no email/SMS/WhatsApp provider connected (provider config).
  3. Books balance — no journal entries produced in this run.
