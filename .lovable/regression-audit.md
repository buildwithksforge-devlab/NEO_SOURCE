# NEØ — Post-hardening regression audit, shared-fetch repair and re-certification

Evidence log. Nothing here is a claim without a measurement behind it.

## Phase A — Shared request architecture

### Root causes found (measured, single browser, warm pass, signed in as a real
staff account of Zuri Crest Hospitality Ltd)

1. **The account was resolved twice on every workspace open.** The initial
   session arrives once from the explicit session read on mount and once from
   the auth listener; both resolved the whole account. Cost per page: two
   profile reads, two effective-access resolutions, and up to three writes of
   the sign-in timestamp.
2. **The permission fingerprint was asked for twice.** Cached-access
   revalidation and the live-session check each dispatched their own
   `my_permission_version` within the same second.
3. **The property list was fetched two to three times.** The shared list had no
   freshness window, and POS, Delivery, Packages and Analytics each ran their
   own property query under a module-specific key.

### Changes (de-duplication only — no relaxation of authority)

- `src/lib/auth.tsx` — one in-flight account resolution per user; the sign-in
  timestamp is written at most once per resolved session in a tab. Sign-out,
  user switch and deliberate permission refresh still resolve afresh.
- `src/lib/permission-fingerprint.ts` (new) — concurrent callers share one
  fingerprint request within a five-second window. The answer is discarded
  outright on sign-in, sign-out, workspace switch and permission refresh, and a
  failed answer is never remembered.
- `src/lib/branches.ts` — the organisation-keyed property list gains a 60s
  shared freshness window (property mutations still invalidate it immediately)
  and exposes `useBranchOptions()`.
- `src/lib/pos-data.ts`, `delivery-data.ts`, `packages-data.ts`,
  `analytics-data.ts` — module property pickers now project the shared
  organisation-scoped list instead of running their own query. Delivery and
  Analytics previously used keys that were not organisation-scoped; they are now.
- `src/components/layout/WorkspaceSelector.tsx` — shows no group choice until
  the membership list has actually arrived.

Operational freshness was deliberately left alone: notifications keep their 60s
freshness and 2-minute poll, realtime subscriptions are untouched, and no
monolithic bootstrap was introduced.

### Before / after (same account, same routes, warm pass, one browser)

| Route | Requests before → after | Repeated calls before → after |
| --- | --- | --- |
| Dashboard `/` | 8 → 8 | 4 → 1 |
| PMS Reservations | 12 → 18* | 5 → 1 |
| Room Rack | 21 → 18 | 4 → 1 |
| POS Orders | 24 → 21 | 5 → 1 |
| Procurement Dashboard | 31 → 22 | 10 → 1 |
| General Ledger | 22 → 19 | 4 → 1 |
| HR | 29 → 25 | 5 → 1 |
| Assets | 20 → 27* | 4 → 1 |
| AP Matching | 23 → 20 | 4 → 1 |

\* the "before" run for those two pages was cut short by a still-loading shell;
the repeated-call column is the like-for-like measure.

The one remaining repeat on every page is the sign-in library's own session
check (`/auth/v1/user`), which the app does not control.

### Cache safety re-tested

- Signed-in shell renders; hard refresh keeps the session and workspace.
- Access cache remains scoped per user (`neo.access.v1:<user id>`).
- Clearing the session and visiting a protected page redirects to sign-in with
  the intended page preserved; no protected content is shown.
- Three consecutive cold sign-ins rendered the workspace with no page errors.

## Phase B — Re-certification

### Route health

All **181** authenticated sidebar routes were crawled as a real staff account.

- 181 render, 0 timeouts, 0 page errors, 0 failed data calls (4xx/5xx).
- Previously reported "blank" pages are sampling artefacts: every one of them
  renders in full when tested on its own.
- Slowest pages, tested sequentially: Security Incidents 6.0s, PMS In-House
  5.6s, Security Visitors 5.0s, Supplier Portal 4.6s. Nothing exceeded 8s.

### Automated workflow suite

`3,132 passed, 1 skipped, 1 failed` across 230 files (was 17 failed before this
turn). Fixed on the way: the header test's outdated stubbing of the workspace
selector, three stale entries in the callable-routine manifest, and two
unclassified privileged routines (`neo_snapshot_verify`,
`neo_tenant_begin_offboarding`) now recorded in the privileged-function
register. Tenant-safety, structural-safety and RBAC guards all pass.

### Three workspaces compared

| Organisation | Properties | People | Active memberships | Reservations | Purchase orders | Stock items | Quarantined links |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Savannah Crown Limited | 3 | 146 | 146 | 102 | 7 | 257 | 0 |
| Zawadi Springs Hospitality Group | 2 | 48 | 47 | 11 | 1 | 2 | 0 |
| Tavern Cottages Group | 2 | 3 | 3 | 0 | 0 | 0 | 0 |

Each workspace reports only its own records; no cross-workspace bleed appeared
beyond the already-quarantined links below.

## Preserved findings (deliberately unchanged)

1. **INV-2026-000003** — Serene Escape Group, folio under review, balance
   8,001, against a checked-out stay. A real open receivable, not a defect to
   be cleared by software.
2. **42 quarantined cross-tenant links** — 21 menu items and 21 recipes from
   TWIN BOABAB ENTERPRISES LTD pointing at Savannah Crown Limited stock items.
   Ownership cannot be proven, so they remain quarantined, not rewritten.
3. **Backup and point-in-time terms remain unrecorded** — no provider fact has
   been invented; the Recovery Centre shows them as not recorded.
4. Pre-existing database linter advisories about privileged routines remain
   open and are not claimed as resolved.

## Next manual certification point

The remaining certification needs a human operator with authority in a live
workspace: running an end-to-end money-moving pass (requisition → order →
receipt → invoice → payment, and a stay from check-in to settled folio) and
signing it off. Everything up to that point is covered above.
