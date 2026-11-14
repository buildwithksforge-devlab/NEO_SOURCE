# NEØ batches 13–18 — cash, stock counts, returns and exact QA products

**22 untouched/queued · 30 active/partial · 26 awaiting deployment/retest · 25 awaiting workflow tests.** One print-agent record awaits deployment, one is partially verified, and one is fully verified.

Fresh full application retest: **4,044 passed, zero failed, 155 skipped**. Original 3,667 unique named passes and prior application 3,920 named passes were retained. Fresh TypeScript and production build/server smoke passed. Additional isolated SQL tests: **128 passed** (count 29, store movements 29, direct POS till/intent 24, exact QA-menu repair 14, routed cash 32). Focused client checks are included in the broad suite, not added to its pass count.

## Cash and payment capture

Ten client cash commands now require persisted status/identity evidence and valid finite amounts before success feedback. Transfer replay without its optional repeated number remains compatible; stale refund decisions cannot be shown as a new approval/rejection. Business failure details and invalid literal reference strings are handled consistently. The wrapper uses the existing callRpc call-site convention so runtime auth/telemetry and the unchanged manifest check both remain effective.

The actual POS recording function now refuses borrowed/cross-property/non-open supplied tills and wrong-order idempotency intents before settlement. Historical inconsistent property links are refused rather than rewritten. Its card metadata overload remains unchanged. Four actual routed-cash functions now enforce source/intent/property identity, exact-property till selection, assigned-cashier authority, finite amounts, pending-provider headroom and actual confirmed-payment totals. Confirmed replay requires matching saved receipt/payment evidence. PMS cash retains its saved allocation path. Operational accounting triggers are not loaded by the isolated fixture, so complete ledger integration remains a separate gate.

## Counts, issues, returns and maintenance

Counts cannot report a successful save without the returned row/value. Uncounted lines produce an incomplete warning rather than a clean reconciliation. Reconciliation totals and stock adjustment decisions must match the saved request/final status. The actual count-submission function locks submitted lines and refuses incomplete, empty, non-finite, negative-valuation, out-of-scope and invalid-state counts before closing or creating corrections. A variance creates one pending independent correction, without posting stock.

The actual issue/return function refuses non-finite/nonpositive quantities, invalid supplied/configured costs, silently skipped mixed submissions and missing saved movement IDs. Authorization/property checks apply before replay, and a per-attempt lock protects the original result. Positive issue/return signs, rollback, unknown valuation, replay and preserved privileges are tested with modeled movement/GL dependencies. Maintenance stock use requires real part/movement IDs, and its history/job-stock reads carry organization context.

## Confirmed public QA data

Read-only anonymous inspection of Savannah Nairobi returned 28 unique published products across three fulfilment channels and identified two explicit QA products: NEO QA Egg Plate Sep27 and NEO-UAT-20261022 Beef & Vegetable Plate TEST (described as synthetic with no physical preparation). The database connector returned an internal error, so inspection used only the existing anonymous storefront API; no staff or financial data was queried. No credentials are included in the evidence.

SQL 103 is an exact-ID/name/org/property/state-guarded, audited, idempotent unpublish/disable repair for those two products. It retains product IDs, prices, taxes, recipe references and history. SQL 104 verifies the two states and omission from all three public channels. The repair is **prepared and isolated-tested, not applied to production**, and deliberately lives outside automatic migrations.

## Installation candidates

- SQL 97 / postcheck 98: count completeness; code-only migration 20261108170000.
- SQL 99 / postcheck 100: store movement boundaries; code-only migration 20261108180000.
- SQL 101 / postcheck 102: direct POS till/intent; code-only migration 20261108190000.
- SQL 103 / postcheck 104: two exact QA catalog records; explicit data repair, not an automatic migration.
- SQL 105 / postcheck 106: routed cash context/creation/settlement; code-only migration 20261108200000.

All installers refuse unreviewed definitions or changed exact-record identity. None was applied to an operational database during this batch. Do not blanket-push old migrations containing unrelated historical changes.

## Original records advanced

- **NEO-BKL-A04**: Cash mutation success now requires real matching persisted status/receipt evidence. POS direct capture and routed cash enforce source/property/till/cashier identity, reserved headroom, actual confirmed-paid totals and valid replay links. Actual reviewed POS/card and four routed-cash functions pass isolated tests. Known capture-consistency code scope is ready; full journal/shift/role acceptance remains a deployment gate.
- **NEO-BKL-J02**: Payment/till boundary subfixes now cover correct collector/property, request replay identity, confirmed receipt evidence, remaining POS headroom and actual-payment totals. Read-only end-of-shift reconciliation and actual accounting-trigger integration still need complete acceptance.
- **NEO-BKL-J04**: Transfer/refund/cash hooks refuse unknown outcomes or mismatched decisions instead of claiming shift cash was received/paid. Pending-provider headroom and collector/property are enforced in routed capture. Actual closing, cash count, variance and independent shift review remain open.
- **NEO-BKL-I03**: Maintenance material usage requires finite positive quantity and confirmed part/movement IDs. Asset-history and job-stock caches are organization-scoped, and history explicitly filters organization. Full asset/service-history, costing and independent closure integration remain open.
- **NEO-BKL-G01**: Known return boundary now refuses malformed quantities/costs, wrong scoped stores, partial skipped submissions and missing movement IDs; confirmed client result must match direction/location/movement count. Replacement-specific workflows remain open.
- **NEO-BKL-G03**: Known count/return source defects are repaired: incomplete/non-finite/invalid-state counts cannot close, variance creates one pending correction, genuine zero counts remain valid, and issue/return input, replay and saved-movement proof are guarded on both client/server. Physical stock and independent correction approval remain retest gates.
- **NEO-BKL-C08**: Issues/returns and count variance gained tested client/server guard fixes, explicit incomplete-count feedback and matching adjustment final-status evidence. Full requisition ownership, replacements and issue/receipt handoffs remain open.
- **NEO-BKL-M02**: Read-only anonymous storefront inspection confirmed two exact QA products. SQL 103 is a tested, audited, idempotent unpublish/disable candidate for those two IDs only; prices, recipe/product IDs and historical transactions remain retained. Not applied to production: the observed QA items remain visible until controlled application.
- **NEO-BKL-C05**: Known duplicate-consumption code scope is ready: per-item and per-attempt serialization precedes replay lookup, valid replays preserve original movement IDs, and saved movement proof is required. Tests cover sequential replay/rollback and lock placement; multi-session races and actual service/payment/void workflows remain deployment/retest gates.
- **NEO-BKL-C07**: Known quantity/yield code scope is ready across plan capture and actual POS recipe/batch core: finite positive values, nullable active-recipe detection, recipe fractions and converted batch amounts are tested; invalid downstream expansion rolls back. Actual recipe configurations and physical portion validation remain workflow gates.
- **NEO-BKL-R06**: Additional direct/routed cash replay, till, property and source checks; branch-scoped till context; organization-filtered cash/asset reads; confirmed-source provenance is validated. Read-only public inspection touched Savannah Nairobi only. Valid protected other-organization behavior is retained in isolated cases; reciprocal full-role testing remains open.

The remaining untouched and partial records are still open. This report does not certify full departments, actual shift close, suppliers/AP, owner-approved tax/FX policy features, physical printers/stock or provider inbox delivery.
