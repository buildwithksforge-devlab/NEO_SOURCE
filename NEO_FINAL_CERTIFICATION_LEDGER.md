# NEØ Final Production Certification Ledger

**Campaign:** Final Forensic / Pre-Go-Live  
**Started:** 24 September 2026  
**Latest source package:** `NEO-production-handoff-2026-09-24-finance-controls.zip`  
**Archive SHA-256:** `0615eef1245353fb7945e0eb7aede4d3e20be52017eeb16796c553c1e19bbef3`

## Gate 0 — Deployment parity ledger

| Item | Status | Evidence / note |
|---|---|---|
| Source archive | Observed | NEO-production-handoff-2026-09-24-finance-controls.zip |
| Git metadata | UNKNOWN / NOT VERIFIED | No `.git` directory in export; commit and branch cannot be derived. |
| Node runtime | Source-declared | `.nvmrc` = Node 22 |
| npm lock | Observed | `package-lock.json` lockfileVersion 3; root dependencies match package.json |
| Bun lock | Observed | `bun.lock` present |
| Current source UI routes | Observed | 386 UI/root route files |
| Current public API routes | Observed | 5 public API route files |
| Current test/spec files | Observed | 257 |
| Current migrations | Observed | 978 |
| Latest migration | IMPLEMENTED, NOT VERIFIED | `20260924090000_finish_controlled_finance_flows.sql` |
| Configured Supabase project ref | Observed | `zlrrmrcqlerafptkgucl` from `supabase/config.toml` |
| Remote production migration history | UNKNOWN / NOT VERIFIED | Requires connection to the actual NEØ production Supabase project. |
| Published deployment revision | UNKNOWN / NOT VERIFIED | Export has no Git/deployment metadata. |
| Latest archive build/test | UNKNOWN / NOT VERIFIED | Baseline 23 Sep checkpoint passed; 24 Sep finance-control delta has not yet been freshly built in this audit environment. |
| External providers | UNKNOWN / NOT VERIFIED | Must be checked from target runtime/provider configuration; no fabricated success. |

### Source drift from 23 Sep baseline

- Added deployment hardening, environment template, production/live CI gates, connector-secret boundary, controlled-finance contract test and one finance-control migration.
- Latest archive contains **978 migrations**, not 977.
- Latest archive contains **257 test/spec files**, not 255.
- Actual source contains **391 route files total: 385 parsed screen routes + root + 5 public API routes**. Any older 387-route figure is superseded by source inspection.


## Gate 0 live parity findings — connected Lovable project

The connected Lovable workspace was inspected directly.

- Lovable project: **Hospitaility Operating System**
- Project ID: `7d9bb747-81b5-404e-84f5-1984259ee068`
- Lovable project status: **ready / published**
- Latest Lovable source commit visible through the connector: `f02c9d7b5751c9cfee12e6e1116039d65dbfaf10`
- Lovable project's own `supabase/config.toml`: `project_id = "zlrrmrcqlerafptkgucl"`
- Therefore the manually opened Supabase project `yxgskzglylguyikbhskl` is **not the backend referenced by the NEØ Lovable source**.
- Connected production database migration ledger: **986 applied entries**, latest applied version `20260923075357`.
- Migration `20260923103000_canonical_payment_journal_resolution.sql`: **not applied** in the connected database.
- Migration `20260924090000_finish_controlled_finance_flows.sql`: **not applied** in the connected database.
- Those two migration files are also **not present** in the current Lovable source commit inspected.
- The 24 Sep local handoff's production-gate scripts, controlled-finance test and production audit report are likewise not present in that Lovable commit.

**Parity decision: FAILED / BLOCKING.** The newest local handoff is ahead of the currently published Lovable source and connected database. Functional failures found on the current published build cannot automatically be attributed to the latest local source, and the latest local finance controls cannot be called live.

**Important migration-history anomaly:** the connected database has 986 applied migration rows while the latest local handoff contains 978 migration files. The common recent point is `20260923075357`, but historical migration counts differ. This must be reconciled by version/name before any push; do not blindly replay the local migration folder.

## Gate 1 — Static application surface inventory

This is source inventory only. Every entry remains **IMPLEMENTED, NOT VERIFIED** until the corresponding runtime route/control is exercised.

| Domain | Screen/root routes |
|---|---:|
| Administration | 53 |
| Finance | 31 |
| PMS/Front Office | 27 |
| Events | 22 |
| Marketing | 21 |
| HR/Payroll | 20 |
| Stay & Dine / Guest | 19 |
| Kitchen | 18 |
| Platform/Readiness | 16 |
| Restaurant/POS | 15 |
| Inventory/Stores | 15 |
| Automation/Notifications | 12 |
| CRM | 12 |
| Delivery | 12 |
| Housekeeping | 11 |
| Procurement | 10 |
| Pastry | 9 |
| Authentication/Identity | 9 |
| Security | 9 |
| Maintenance | 8 |
| Bar | 6 |
| Laundry | 6 |
| Discover/Public | 6 |
| Reports/Analytics/AI | 5 |
| Rider | 5 |
| Work/Common | 4 |
| Other | 2 |
| Approvals | 1 |
| Partner | 1 |

Static JSX/control scan across route files found approximately:

- **Buttons:** 1196
- **Links:** 262
- **Forms:** 19
- **Dialogs Drawers Sheets:** 124
- **Selects:** 423
- **Inputs:** 813
- **Tables:** 188
- **Tabs:** 42

These are source-presence counts, not proof that controls are visible, authorised, wired, or correct at runtime. The per-route ledger is in `NEO_ROUTE_CONTROL_LEDGER.csv`.

## Role source inventory

`role-templates.ts` currently defines **52 role templates**. The actual runtime role catalogue/database remains to be reconciled before role certification.

`owner`, `operations-manager`, `finance-manager`, `accountant`, `food-and-beverage-manager`, `waiter`, `barista`, `bar-attendant`, `head-chef`, `hot-kitchen-chef`, `chief-steward`, `kitchen-steward`, `head-pastry-chef`, `pastry-chef`, `front-office-supervisor`, `front-office-manager`, `hot-kitchen-supervisor`, `coffee-station-supervisor`, `restaurant-manager`, `bar-manager`, `cashier`, `social-media-manager`, `receptionist`, `reservations-agent`, `front-office-cashier`, `porter`, `driver`, `housekeeping-supervisor`, `housekeeping-manager`, `laundry-manager`, `maintenance-officer`, `housekeeper`, `laundry-supervisor`, `laundry-attendant`, `maintenance-manager`, `maintenance-technician`, `grounds-worker`, `marketing-manager`, `sales-and-events-manager`, `events-coordinator`, `banqueting-staff`, `procurement-manager`, `procurement-officer`, `storekeeper`, `receiving-clerk`, `human-resources-manager`, `hr-officer`, `security-supervisor`, `security-guard`, `it-system-administrator`, `delivery-manager`, `rider`

## Immediate blocking truth

The Supabase project opened during setup in the current conversation (`yxgskzglylguyikbhskl`) does **not** match the repository project reference (`zlrrmrcqlerafptkgucl`). It must not be treated as the NEØ production database until the mismatch is resolved. No migration should be applied to either project merely to make the numbers line up.

## Next certification actions

1. Identify the actual NEØ production Supabase project and obtain its migration history read-only.
2. Establish the deployed frontend/build revision and match it to source.
3. Fresh-build/test the 24 Sep source delta on the networked Windows/GitHub environment.
4. Only after parity, begin runtime route/control sweep and the Identity Relationship Gate.

## Campaign continuation — 24 Sep live/backend forensic pass

### Exact migration divergence

The source/database mismatch is now narrowed precisely enough to prohibit a blind migration push.

- **Remote applied ledger:** 986 versions.
- **Local migration files:** 978.
- **Remote-only historical versions:** 14 total:
  - 20260811121012
  - 20260811124530
  - 20260811130348
  - 20260811130413
  - 20260811130552
  - 20260811134210
  - 20260811134952
  - 20260811135534
  - 20260817064400
  - 20260817080714
  - 20260817081123
  - 20260817081611
  - 20260817083729
  - 20260830181908
- **Local-only versions/files:** 6 total:
  - `20240829_document_engine_outputs.sql`
  - `20260823120000_grn_line_over_receipt.sql`
  - `20260823170000_permission_key_aliases.sql`
  - `20260901000000_fix_night_audit_request_number.sql`
  - `20260923103000_canonical_payment_journal_resolution.sql`
  - `20260924090000_finish_controlled_finance_flows.sql`

Some local-only effects already exist in the live schema despite the migration versions not appearing in the remote ledger (for example the permission alias table/canonical permission function and document payload function). Therefore the live database has **schema drift / partial historical application**, not merely a clean missing-tail condition.

### Final-finance migration live state

The connected production database has older versions of several control functions, but not the complete 24 Sep contract:

- `neo_payment_schedule_release`: present and already contains maker/releaser + advisory-lock evidence.
- `neo_supplier_payment_advance`: present.
- `neo_cash_refund_settle`: present, but not the final cash-funds guard contract.
- `cash_close_shift`: present, but not the final mandatory counted-cash / variance-review contract.
- `neo_close_business_day`: present.
- `neo_open_business_day`: **missing**.
- `neo_pos_apply_discount`: present, but not the final hard 15% Operations Manager / Owner ceiling contract.
- `neo_payment_posted_journal`: **missing**; therefore the 23 Sep canonical POS/payment read-model correction is not deployed.

**Classification:** latest finance controls = **IMPLEMENTED, NOT LIVE VERIFIED**; current published database = **STALE/PARTIALLY DRIFTED DEPLOYMENT** relative to latest handoff.

### Gate 1 — route/link defect discovered

Static literal-navigation audit inspected 1,064 internal references and found one real orphan destination in the published source: supplier record search linked to `/procurement/suppliers`, but that route does not exist in the generated router. The real supplier screen is `/admin/suppliers`.

- Published Lovable commit: defect present.
- Latest local handoff: corrected to `/admin/suppliers` and contains `record-search-route-integrity.test.ts` regression coverage.
- Capability map still contains a legacy `/procurement/suppliers` prefix, but the real `/admin/suppliers` capability entry exists and is mapped to `procurement.suppliers.edit`.

**Classification:** published build = **FAILED / DEFECT** for that search destination; local handoff = **IMPLEMENTED, NOT LIVE VERIFIED** fix.

## Security / tenancy backend checks

Read-only structural checks against the connected database returned **zero violations** for:

- duplicate active property names within an organisation
- multiple active main properties per organisation
- duplicate active department names
- duplicate active canonical role keys
- duplicate staff IDs
- duplicate employee numbers
- department → wrong organisation
- role → wrong organisation
- stock location → wrong property department
- profile → wrong property department
- employee → wrong property department/station
- station → wrong property department
- user-station → wrong property
- orphan/cross-organisation user-role links

The shared structure guard trigger is installed on departments, employees, operational stations, profiles, roles, stock locations and user stations.

**Classification:** **BACKEND VERIFIED** structural tenancy integrity. This does not replace real anonymous/wrong-role/direct-URL runtime security tests.

## Identity Relationship Gate — backend evidence

The database can represent one human with multiple separate relationships:

- 11 live examples of **Employee + Rider** linked through the same profile/employee identity.
- 1 live example of **Customer + Employee** linked through the same authentication/profile identity.
- 2 active Partner access-relationship rows exist, but no current Customer + Partner overlap was found.

RLS evidence is relationship-specific:

- customer self-read: `auth_user_id = auth.uid()`
- employee read: organisation + employee/self/HR/manager/department scope
- rider self-update: rider profile identity + rider availability permission
- access relationship self-read: `auth_user_id = auth.uid()`
- user-role read: organisation + self or role-directory permission

Source context resolver explicitly derives Work/Partner/Rider entrances from real relationships and Guest from real stay history; authentication alone does not create Guest.

**Classification:** **BACKEND VERIFIED / IMPLEMENTED, NOT LIVE VERIFIED**. Browser context selection, switch-context, switch-account, expiry, direct URL and logout/Back remain mandatory live tests after deployment parity.

## Protected Run 1 — read-only regression

Property: **Zuri Crest Hotel Nakuru**.

Protected chain remains present:

- `RES-2609-0AD9C`: checked-out, total KES 13,920, VAT KES 1,920, payment status paid.
- matching folio number `INV-2026-000004` in the Run-1 property: settled, charges KES 13,920, payments KES 13,920, balance 0.
- `RCT-2026-000003`: cash KES 13,920, confirmed, linked to protected reservation/folio and posted journal.
- `JV-MAIN-2026-000007`: posted, balanced KES 13,920. Lines: Dr AR 13,920 / Cr Room Revenue 12,000 / Cr VAT 1,920.
- `JV-MAIN-2026-000008`: posted, balanced KES 13,920. Lines: Dr Cash on Hand 13,920 / Cr AR 13,920.
- `HOU-2026-000002`: completed, inspection passed.
- Room 102: active, vacant, clean, inspection passed, `vacant-clean`, sellable.
- linked cashier shift: closed; expected KES 13,920; counted KES 13,920; variance 0.
- audit chain contains room assignment, check-in, cash receipt confirmation, checkout, housekeeping handoff, assignment, start, completion and passed inspection actors/timestamps.

A legacy folio-line field still stores `net_amount=13,920` while the canonical projection function contains the corrected `gross - tax - service` net calculation. Do not mutate that historical line merely to make the raw field look cleaner.

**Classification:** **BACKEND VERIFIED regression preservation**. Existing prior live certification is preserved; fresh UI projection regression remains pending parity.

## Run 2 — F&B backend reconciliation

Existing records were inspected without mutation.

- `POS-20260923-S5MWE` (Zuri Crest): subtotal 2,100; service 210; total 2,310; still unpaid/partially-served.
- Its tickets show Hot Kitchen = ready, Main Bar = served, Pastry = ready.
- `POS-20260923-WTGRH` (Savanna Crown): paid KES 2,090; subtotal 2,050; discount 150; service 190; VAT 262.07.
- `RCT-2026-000015` is a `pos_payments` receipt for KES 2,090 linked to that order.
- `JV-SCN-2026-000200` is posted and balanced KES 2,090: Dr Cash 2,090 / Cr Bar Revenue 1,637.93 / Cr VAT 262.07 / Cr Service Charge 190.
- Beef Burger line has stock movements with unique consumption/wastage idempotency keys.
- RUN2 Gin Tot 30ml has an active one-ingredient recipe and a bottle/open-container event proving **exactly one 30 ml pour**: open volume moved 690 ml → 660 ml with a line-specific idempotency key.
- RUN2 Gin & Coke and RUN2 Pastry Flatbread have active recipes with **zero ingredients**.
- RUN2 Omelette has two configured ingredients but the line/ticket is still `ready`, not served.

**Classification:** mixed **BACKEND VERIFIED** + **BUSINESS CONFIGURATION REQUIRED**. Missing recipe ingredients are configuration gaps, not a stock-engine failure. Run 2 is not closed: complete serve/settlement, cancellation/reversal, report/audit and live persona proof remain.

## Run 3 — Supply Chain / Payables backend reconciliation

Savanna Crown existing invoices:

- `CS-UAT-4471`: KES 36,000, matched, approved, paid amount 0, posted AP journal.
- `UAT-SINV-300826-001`: KES 2,000, matched, approved, paid amount 0, posted AP journal.
- Combined outstanding invoice truth: **KES 38,000**.
- No `supplier_payments` rows exist against either invoice.
- Their posted journals credit Accounts Payable by 36,000 and 2,000 respectively (with matching GRNI debits).
- Supplier master for CleanStay Supplies currently stores `outstanding_balance = 0`.

This is a real reconciliation inconsistency between approved/unpaid invoice + AP ledger truth and the supplier-master denormalised field. No supplier row was edited.

**Classification:** invoices/AP = **BACKEND VERIFIED**; supplier master balance = **FAILED / READ-MODEL OR DENORMALISED-BALANCE INCONSISTENCY**; payment/remittance remains **NOT CERTIFIED** and must use the existing invoices after the final finance migration is deployed.

## Run 4 — Laundry record ambiguity

`LAU-2026-000002` is not globally unique: it exists in at least two properties.

- Zawadi Springs Nairobi record: completed, posted, total KES 2,088, linked to reservation/room/folio.
- Savanna Crown record (the later certification context): status `delivered` but `delivered_at` is null; posting status `blocked`; no reservation, room or folio link; one line = 2 shirts at KES 300 each; no matching audit-log rows were found by order ID.

**Classification:** Savanna record = **LIVE/BACKEND PARTIAL with unresolved lifecycle/financial/audit gaps**. Do not substitute the stronger Zawadi record merely because it shares the same laundry number.

## Run 5 — Delivery accounting preservation

Savanna Crown delivery evidence remains coherent for the corrected billing records:

- `DEL-2026-000009`: delivered/paid, total KES 2,785.
  - invoice `INV-SCN-2026-000005`, balance 0.
  - journal `JOU-2026-000002`: Dr Cash 2,785 / Cr Delivery Revenue 2,225.86 / Cr Service Charge 235 / Cr VAT 324.14.
- `DEL-2026-000010`: delivered/paid, total KES 2,785.
  - invoice `INV-SCN-2026-000006`, balance 0.
  - journal `JOU-2026-000003` with the same balanced allocation.
- `DEL-2026-000008`: paid pickup, total KES 2,585.
  - invoice `INV-SCN-2026-000007`, balance 0.
  - journal `JOU-2026-000004`: Dr Cash 2,585 / Cr Delivery Revenue 2,025.86 / Cr Service Charge 235 / Cr VAT 324.14.

**Classification:** **BACKEND VERIFIED** delivery billing/journal arithmetic. Full Rider/PIN/POD/settlement and live customer handoff remain partial.

## Run 6 — readiness / blockers

For Savanna Crown + Zuri Crest:

- no payroll period currently exists scoped to either property.
- no refund/cash-refund/POS-refund record currently exists in either property.
- no `business_days` row currently exists in either property.
- five POS shifts are currently open: four in Savanna Crown, one in Zuri Crest; none has counted cash entered.
- some open shifts are stale from August/early September.

Across the wider database there are payroll periods and one prior business-day/Night-Audit example, but those belong to different/global contexts and cannot certify the two current properties.

The existing prior business-day example (`Main Property`, 15 Sep) is closed with a completed/signed Night Audit and a 16 Sep day left open; it is reusable architecture evidence only.

**Classification:** Run 6 remains **NOT CERTIFIED**. Genuine cash counts, eligible payroll/refund records and the final business-day migration are required; EOD stays last.

## Discount-policy truth

Savanna Crown currently contains only two active configured POS discount policies and both are explicitly synthetic certification data:

- `CERT Synthetic Bill Discount 10%` — no approval required.
- `CERT Synthetic Manager Discount 25%` — approval required.

No equivalent policies were found for Zuri Crest in the inspected query. Therefore these cannot be called the hotel's final real production policy. The 24 Sep source migration adds a server-side hard authority ceiling (Operations Manager ≤15%; >15% Owner + reason), but that migration is not live.

**Classification:** server authority rule = **IMPLEMENTED, NOT LIVE VERIFIED**; final hotel discount configuration = **BUSINESS CONFIGURATION REQUIRED**.

## External/provider state — observed without exposing secrets

Savanna Crown organisation:

- Daraja/M-Pesa integration: enabled, sandbox, status configured, health healthy, sandbox test passed; this is **sandbox evidence**, not real production-money certification.
- Africa's Talking SMS: connected.
- Resend email: connected.
- OpenAI provider connection: connected.
- WhatsApp: disabled / configuration incomplete (`token` still needed).
- separate Lovable AI provider setting: enabled but last check = `unauthorised` (provider rejected key).

No corresponding provider rows were returned for the inspected Zuri Crest organisation.

**Classification:** mixed **EXTERNAL DEPENDENCY / CONFIGURATION REQUIRED / BACKEND VERIFIED provider status**. Never upgrade sandbox/configured to live production success.

## Campaign progress update — 24 Sep 13:35 EAT

### Latest source state

The active certification working copy has advanced beyond the earlier 24 Sep handoff:

- Route files: **392**
- Test/spec files: **262**
- Migration files: **982**
- New final-certification migrations now present:
  - `20260924133000_payroll_posting_release_guard.sql`
  - `20260924134500_pos_prepaid_service_guard.sql`
  - `20260924140000_guest_laundry_lifecycle_guard.sql`
  - `20260924141500_refund_payment_journal_sign_guard.sql`

Fresh typecheck/test execution on this audit machine is still **BLOCKED — ENVIRONMENT** because `node_modules` is not installed and the runner cannot currently fetch dependencies. A direct `npm run typecheck` fails immediately on missing `vite/client` types, which is an environment/dependency absence, not a source compile verdict.

### Run 2 — F&B backend findings

- Protected POS records remain present across Zuri Crest and Savanna Crown.
- Zuri `POS-20260923-S5MWE` retains Hot Kitchen, Main Bar and Pastry station tickets.
- Gin Tot 30 ml stock consumption is **BACKEND VERIFIED** through the bottle/open-container ledger: the open Gordon's Gin container moved from 690 ml to 660 ml exactly once with an idempotency key tied to the POS line.
- `RUN2 Gin & Coke` and `RUN2 Pastry Flatbread` have active recipes with **zero recipe ingredients**: **BUSINESS CONFIGURATION REQUIRED**, not a stock-engine defect.
- Savanna `POS-20260923-WTGRH` is paid KES 2,090 with `RCT-2026-000015` and balanced journal `JV-SCN-2026-000200`.
- Published Payment Register/Lifecycle read models still lack the canonical POS-payment journal helper; `RCT-2026-000015` has a payment-attempt row with no posted-journal link even though the order's revenue journal exists. **FAILED / DEFECT until `20260923103000_canonical_payment_journal_resolution.sql` is deployed and retested.**

### Run 3 — Supply Chain & Payables backend findings

- `CS-UAT-4471`: approved/matched supplier invoice, KES 36,000, unpaid.
- `UAT-SINV-300826-001`: approved/matched supplier invoice, KES 2,000, unpaid.
- AP journals are posted and balanced: KES 36,000 + KES 2,000 = **KES 38,000 Accounts Payable**.
- No supplier-payment rows exist against either invoice.
- Supplier master `CleanStay Supplies (SCN)` currently reports `outstanding_balance = 0` despite the unpaid KES 38,000 AP truth. **FAILED / READ-MODEL RECONCILIATION DEFECT** until traced/fixed.
- Existing KES 2,000 bank-transfer schedule is still `scheduled`, has no maker (`created_by` null), and Savanna Crown has no configured `bank_accounts` row. Final supplier release therefore remains blocked by **BUSINESS CONFIGURATION REQUIRED + maker/checker evidence**.

### Run 4 — Laundry backend findings

`LAU-2026-000002` is not globally unique; at least two properties contain that number. Property scoping is mandatory.

Savanna Crown's `LAU-2026-000002` is currently inconsistent:

- status = `delivered`
- delivered_at = null
- delivery_confirmed_by = null
- posting_status = `blocked`
- no reservation, room or folio
- no laundry batch exists
- no audit rows for the order

This is **FAILED / DEFECT + incomplete lifecycle evidence**, not live certification. The local source now contains a lifecycle guard requiring a real guest batch, customer/stay linkage, completed batch, delivery timestamp/actor and posted charge before completion/closure. This remains **IMPLEMENTED, NOT LIVE VERIFIED** until deployed and retested against the existing record where possible.

### Run 5 — Delivery / Events backend findings

- `DEL-2026-000005`, `DEL-2026-000009`, `DEL-2026-000010` show real rider delivery completion evidence.
- PINs for the representative deliveries are consumed, and delivery proofs record `pin_verified = true` with the rider and confirmation timestamp.
- Delivery invoices/journals for `DEL-000008/9/10` reconcile correctly, including service charge and VAT.
- Event `EVT-SCN-2026-000001` is confirmed, total KES 102,000, deposit/paid amount KES 50,000, and the deposit journal correctly posts Dr Bank / Cr Event Deposits KES 50,000.
- Rider cash remittances exist but remain only `submitted`; one Sep-23 remittance has expected KES 7,510, declared KES 2,785 and variance -4,725 with no counted amount or reconciliation. **Run 5 remains LIVE PARTIAL** until remittance settlement/reconciliation is completed legitimately.

### Run 6 — People / Payroll / Refund / Till / EOD findings

Payroll:
- Zuri September 2026 payroll is locked and payslips were released, but `posted_journal_id` and `posted_at` are null; 45 payroll input rows are still `draft` and computed monetary fields are null. **FAILED / DEFECT.**
- Savanna September 2026 payroll is locked with no posted journal and Savanna has no payroll posting-account configuration. **BUSINESS CONFIGURATION REQUIRED + lifecycle defect.**
- Local source now contains payroll release guards so staff self-service only sees payslips after actual Finance posting. **IMPLEMENTED, NOT LIVE VERIFIED.**

Refund:
- Neither Savanna nor Zuri currently has a configured `cash_refund_policies` row. Current fallback threshold = 0, so every refund requires approval. Safe, but **BUSINESS CONFIGURATION REQUIRED** for real production policy.
- `RCT-2026-000014` / `DEL-2026-000011`, KES 1,595 cash, is a safer non-protected refund candidate than protected `RCT-2026-000015`; no refund request exists against it yet.

Till / EOD:
- Savanna Crown has four open POS shifts, including stale August shifts; Zuri Crest has one open POS shift. None has counted cash recorded.
- Sep-23 Savanna till stored `expected_cash = 0`, but canonical reconstruction from confirmed cash receipts is **KES 3,685** (1,595 + 2,090). This validates the need for server-derived expected cash at close.
- Savanna Crown and Zuri Crest currently have no `business_days` rows. Existing successful business-day/Night-Audit evidence belongs to another property.
- Therefore clean EOD certification for these two properties is **BLOCKED** until the final business-day migration is deployed and real open shifts are reconciled with genuine counted cash.

### Identity / RBAC

- Backend relationship separation remains **BACKEND VERIFIED** for Employee + Rider and Customer + Employee examples.
- Runtime context switching/session expiry/logout/direct-URL tests remain **NOT RUN** because deployment parity is not yet established.
- In the two certification organisations, legacy General Manager/Night Auditor records are archived. Zuri legacy display roles `Laundry Supervisor` and `Waitress` follow canonical `laundry-manager` and `waiter` templates with template-sourced permissions; classify as alias/migration residue, not automatic RBAC failure.

### External/provider state observed

Savanna organisation:
- Daraja/M-Pesa: configured sandbox, health healthy, sandbox test previously passed.
- Africa's Talking SMS: connected.
- OpenAI: connected.
- Resend email: connected.
- WhatsApp: configuration incomplete (token missing).
- Lovable AI provider setting: last check unauthorised / key rejected.

These states are current configuration evidence, not full external-provider live certification.

### Current go-live blockers

1. **Deployment parity:** latest certification source is not the published Lovable commit/database state.
2. **Migration parity:** historical ledger drift must be reconciled; do not blind-push.
3. **`20260923103000` canonical payment read-model migration not live.**
4. **24 Sep controlled finance/business-day migration not fully live.**
5. **Payroll release/posting inconsistency and missing Savanna payroll posting config.**
6. **Supplier AP/master-balance inconsistency + no Savanna bank account configuration.**
7. **Savanna laundry lifecycle inconsistency.**
8. **Five open tills require genuine counted cash and closure/reconciliation.**
9. **Real refund policy configuration absent.**
10. **Runtime/browser certification (route/control, identity, permissions, negative security, retry/concurrency, responsive/accessibility) cannot be called complete before matching source is deployed.**

### Distance to completion

Do **not** use a fake percentage. The campaign is past discovery and deep into backend reconciliation, but it is **not yet in the final live-certification phase** because Gate 0 remains blocking. The remaining work is concentrated rather than broad:

1. finish source/migration parity and obtain a clean build/test on a networked runner;
2. deploy matching source + migrations to controlled staging;
3. run the full browser route/control + Identity/RBAC gates;
4. close the named canonical-run defects/configuration gaps above using preserved records;
5. execute refund, supplier payment, genuine counted-cash till closure and business-day/EOD last;
6. run negative security/retry/concurrency/responsive/accessibility gates;
7. final reconciliation dossier and go-live decision.

## Fast-track closure pass — 24 Sep

- Static secret-boundary scan found **no** client `import.meta.env` references to `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `RESEND_API_KEY`, `WHATSAPP_TOKEN`, or generic `NEO_CONNECTOR_*` secrets. Sensitive environment reads observed are server-side/process-environment paths. **Classification: BACKEND/SOURCE VERIFIED STATIC BOUNDARY; runtime bundle sentinel still pending build.**
- Static internal route scan remains **0 unresolved literal internal destinations** after the supplier-route correction.
- A separate Lovable certification remix was attempted to accelerate runtime testing, but the workspace is currently out of Lovable credits. No staging clone was created and no production source/database was modified by that attempt. **Classification: BLOCKED — EXTERNAL/WORKSPACE CAPACITY.**
- Current audit runner also cannot complete `npm ci`: normal install timed out and offline install failed because required package `ajv` was not cached. Therefore typecheck/test/build cannot honestly be called from this runner. A one-command Windows gate `RUN_FINAL_GATE.ps1` has been added to the release package so the user's networked Node 22 machine can execute install → typecheck → offline tests → secret scan → production build → smoke in one pass.

## 2026-09-24 live certification continuation

### Identity / relationship backend
- BACKEND VERIFIED: Customer+Employee identity resolves Work without Rider/Partner.
- BACKEND VERIFIED: Employee+Rider identity resolves Work + Rider for the correct property.
- BACKEND VERIFIED: Partner identity resolves Partner only.
- BACKEND VERIFIED: wrong-property Partner access returns `no_relationship`.
- BACKEND VERIFIED: Customer+Employee Guest RPCs return the personal hotel context and do not surface unrelated stays/laundry.
- BACKEND VERIFIED: Rider RLS exposes the rider's own assigned work plus legitimate unassigned same-property work; the extra visible record tested was `DEL-2026-000006`, not another rider's private assignment.

### Discover / Guest backend
- BACKEND VERIFIED: `neo_property_doors` on Savanna Crown Nairobi reports signed-out Stay & Dine allowed, Work/Rider/Partner not allowed until authenticated/related.
- BACKEND VERIFIED: `neo_public_menu` returns published menu items and prices.
- BACKEND VERIFIED: `neo_guest_room_offers` returns live availability/rate offers for a real stay window.

### Run 1
- BACKEND VERIFIED clean: protected `RCT-2026-000003` appears in Payment Register as posted.
- BACKEND VERIFIED clean: Payment Lifecycle resolves guest, actor, `JV-MAIN-2026-000008`, and exact GL lines.
- BACKEND VERIFIED clean: Folio Projection returns Net 12,000 + VAT 1,920 = Gross 13,920; Collected 13,920; Outstanding 0.

### Run 2
- FAILED / DEFECT: `RCT-2026-000015` is present in Payment Register only as `confirmed` with no posted journal link; Payment Lifecycle returns no ledger stage although `JV-SCN-2026-000200` exists for the settled order.
- BUSINESS CONFIGURATION REQUIRED: some Run-2 recipe records have zero ingredients.
- BACKEND VERIFIED: 30 ml Gin Tot consumption occurs exactly once through the open-container ledger.

### Run 3
- BACKEND VERIFIED: Partner relationship shows the preserved 36,000 + 2,000 unpaid supplier invoices and associated PO/GRN records.
- BACKEND VERIFIED: wrong-property Partner relationship is refused.
- FAILED / READ-MODEL: supplier invoices/AP show KES 38,000 outstanding while supplier master outstanding balance remains zero.
- BUSINESS CONFIGURATION REQUIRED: Savanna Crown has no configured bank account for bank-transfer release.
- BACKEND VERIFIED (rollback-only): supplier payment release refuses without a paying bank account.

### Run 6 / refunds / till
- FAILED / DEFECT: live refund request + independent approval succeeds, but settlement fails because `neo_cash_refund_settle` attempts to edit a confirmed POS payment and `tg_pos_payment_controls` correctly refuses the edit.
- IMPLEMENTED, NOT VERIFIED: `20260924143000_cash_refund_confirmed_transition_guard.sql` added to release source to permit only the controlled full-refund transition after the refund row is settled.
- BACKEND VERIFIED (rollback-only): balanced till close works with Expected 3,685 / Counted 3,685 / Variance 0 -> closed.
- FAILED / DEFECT: live variance close tries `pending-review`, while the current DB constraint allows `variance-review`; variance close therefore fails.
- IMPLEMENTED, NOT VERIFIED: latest release source already uses `variance-review` and the expanded allowed-state constraint.

### Discount authority
- FAILED / RBAC CONFIGURATION: live Operations Manager has `discount.approve=true` but `discount.execute=false`, so cannot apply even the configured 10% discount.
- BACKEND VERIFIED: Owner can apply configured 25% discount in a rollback-only test.
- IMPLEMENTED, NOT VERIFIED: `20260924144500_operations_manager_discount_capability.sql` and source template special capability added; server-side 15% Operations Manager ceiling remains in the release source.

### Runtime/browser limitation
- BLOCKED — ENVIRONMENT: Lovable preview domain is blocked by this execution environment's browser/network policy (`ERR_BLOCKED_BY_ADMINISTRATOR`). Browser-only interaction states (click-by-click route sweep, real session restoration, browser Back/Forward, responsive rendering, live persona context switching) remain not live certified here.

## 2026-09-24 — Continued live backend certification

### Identity / relationship gate
- Customer + Employee: BACKEND VERIFIED. `neo_my_entrances()` exposes Work without Rider/Partner for the test identity; Guest RPCs return only the person's own personal hotel/stay/laundry context.
- Employee + Rider: BACKEND VERIFIED. `neo_my_entrances()` exposes Work + Rider at the correct property; delivery RLS exposes assigned work plus same-property unassigned waiting deliveries, not another rider's private job.
- Partner: BACKEND VERIFIED. Partner supplier relationships are relationship-scoped; wrong-property access returns `no_relationship`.

### Run 1 — protected guest chain
- Payment Register: BACKEND VERIFIED for RCT-2026-000003 as posted.
- Payment Lifecycle: BACKEND VERIFIED with correct guest, actor, JV-MAIN-2026-000008 and GL lines.
- Folio Projection: BACKEND VERIFIED: net 12,000 + VAT 1,920 = gross 13,920; collected 13,920; outstanding 0.

### Run 2 — F&B
- POS payment read model defect remains live for RCT-2026-000015: Payment Register shows confirmed but no `posted_journal_id`; Payment Lifecycle has no ledger stage despite order journal evidence. Classification: FAILED / DEFECT (deployment/read-model linkage).
- Operations Manager live role currently has `discount.approve=true` but `discount.execute=false`, so cannot exercise intended <=15% authority. Owner 25% rollback-only application succeeded. Source fix added in `20260924144500_operations_manager_discount_capability.sql` plus existing server-side 15% ceiling.

### Run 3 — Supply chain / supplier payment
- Partner supplier view returns CS-UAT-4471 and UAT-SINV-300826-001 unpaid with matched/approved status.
- Supplier payment rollback-only release correctly refused without a configured paying bank account: `Choose the bank account this transfer is paid from`.
- Supplier master outstanding balance remains inconsistent with KES 38,000 unpaid AP truth. Classification: FAILED / read-model or master-balance projection defect.

### Run 4 — Operations
- Zuri Run-1 housekeeping chain remains BACKEND VERIFIED completed + passed inspection.
- SCG-HK-00024 remains stale/in-progress (started 26 Aug for 24 Aug due task): retained as stale-task recovery case.
- Maintenance representative WOR-2026-000001 (Zuri) is closed, verified and timestamped; BACKEND VERIFIED representative lifecycle.
- Leave: approved 2-day leave posted exactly once; canonical leave balance shows taken_days=2. Request row `balance_after` remains null. Classification: backend ledger PASS / projection defect.

### Run 6 — Payroll / refund / till
- Zuri Sep payroll compute: 45 employees, 35 missing compensation records. Posting rollback-only dry run correctly refuses: `35 employee(s) have no pay record`.
- Refund rollback-only E2E uncovered live deadlock: settlement attempts to mark confirmed POS payment refunded, but confirmed-payment trigger refuses edits. Source guard migration added: `20260924143000_cash_refund_confirmed_transition_guard.sql`.
- Till exact-count rollback-only close succeeded: Expected 3,685 / Counted 3,685 / Variance 0 / closed.
- Till variance rollback-only close failed live because RPC writes `pending-review` but constraint permits `variance-review`. Latest release source already uses the corrected `variance-review` state. Classification: deployment-parity defect.

### Public / Guest
- Signed-out `neo_property_doors()` correctly shows Stay & Dine allowed; Work/Rider/Partner unavailable without valid relationship/auth.
- Public menu returns live published items/prices.
- Guest room-offer RPC returns availability, rate plans, tax-inclusive totals for real dates/occupancy.

### Queues / automation / notifications
- 17 notification templates exist; no notification render failures found.
- No approval execution failures found.
- No automation settings/rules configured in the inspected live dataset; classify as BUSINESS CONFIGURATION REQUIRED where automation behavior is expected.

### Runtime limitation
- Rendered browser interaction remains NOT RUN in this environment because the Lovable preview domain is blocked by the execution environment. This is not a NEØ defect. Final UI/persona sweep remains the last-mile gate after backend/static defects are resolved.

## Four-entry lived-experience certification — 24 Sep 2026

### Stay & Dine / Guest
- LIVE BACKEND EXPERIENCE: Triza customer identity created a booking via `neo_guest_create_booking`, Work receptionist assigned Room 102 and checked the guest in via `pms_assign_room` + `pms_check_in`, then Guest context resumed and `neo_guest_active_stay` returned the correct reservation/room/open folio.
- LIVE BACKEND EXPERIENCE: Guest cart accepted Beef Burger + House Soda and pay-at-property room service produced a real POS order, delivery order, Grill + Main Bar station tickets, and guest tracking state.
- FAILED / DEFECT: room-charge path failed live with `Folio not found` because Guest profile `current_org_id()` differed from the canonical folio organisation.
- PATCH VERIFIED IN ROLLBACK: `folio_post_charge()` now prioritises the folio's own organisation when `neo_system_posting()` is active. The same room-charge journey then succeeded and posted exactly one folio line.
- FAILED / DEFECT: Guest tracking reported `can_cancel=true` for eligible DEL-2026-000007 but cancellation hit the POS void-authority trigger.
- PATCH VERIFIED IN ROLLBACK: narrowly-scoped `neo.guest_cancel` guard now permits only the signed-in customer's own unpaid eligible order; Delivery + POS + station tickets all cancelled together.

### Work
- LIVE BACKEND EXPERIENCE: Receptionist persona performed room assignment and check-in for a Guest-created reservation; downstream stay, folio, room occupancy and Guest active-stay state were created correctly.
- LIVE BACKEND EXPERIENCE: Delivery Manager `create-assisted` path created a delivery order for an existing Guest customer, reusing the same canonical customer record; POS order, delivery fee/ETA and customer PIN were created.
- DATA QUALITY GAP: authenticated Guest customer profiles in Savanna Crown currently have no usable phone numbers, so Work-assisted phone ordering cannot naturally relink to those Guest accounts until customer phone data is configured/updated.

### Partner
- LIVE BACKEND EXPERIENCE: supplier Partner identity resolved two supplier relationships for Savanna Crown Nairobi.
- LIVE BACKEND EXPERIENCE: CleanStay relationship saw only its own PO/GRN/supplier-invoice chain, including LPO-SCN-2026-000001, GRN-SCN-2026-000001/2/3, CS-UAT-4471 and UAT-SINV-300826-001.
- LIVE BACKEND EXPERIENCE: Partner created a message thread and message as `side=partner`.
- SECURITY PASS: same relationship ID paired with the wrong property returned `allowed=false / no_relationship`.
- SCOPE NOTE: supplier invoice capture/acceptance remains a Work/Finance function; Partner currently provides relationship-scoped visibility + messaging, not supplier self-submission of invoices.

### Rider
- FAILED / DEFECT: live Rider could claim DEL-2026-000007 while Kitchen was `new`, then advance to `collected` and `en-route` before readiness.
- PATCH VERIFIED IN ROLLBACK: `delivery_rider_advance()` now refuses collection unless `kitchen_status` is `ready` or `completed`.
- LIVE BACKEND EXPERIENCE: Delivery Manager scheduled an active rider shift and regenerated an expired PIN with a new 24-hour expiry.
- LIVE BACKEND EXPERIENCE: Rider claimed ready DEL-2026-000006, collected, went en-route, verified customer PIN, created POD, recorded KES 3,680 cash, consumed PIN, and moved order/payment to delivered/paid.
- LIVE BACKEND EXPERIENCE: exact rider cash remittance REM-260915-8200E reconciled to KES 780 by independent Owner/Finance authority into an open till; variance 0 and till expected cash became KES 780.
- OPEN OPERATIONAL EXCEPTION: REM-260923-6790B remains a real KES -4,725 variance and must not be auto-reconciled.

### Cross-entry source hardening added
- `supabase/migrations/20260924150000_cross_entry_guest_rider_guards.sql`
- `src/lib/__tests__/cross-entry-guest-rider-contract.test.ts`

Evidence classification: backend persona journeys are LIVE/BACKEND VERIFIED against the connected production schema using transaction rollback for temporary writes. Rendered browser navigation, visual state, and click-level UX remain a separate last-mile UI gate.

---

## FRONT OFFICE & PMS CONNECTED CERTIFICATION — 2026-09-24

### Scope exercised
Availability → direct Front Office reservation → arrival/check-in → in-house stay → guest request → transport → room transfer → checkout/departure → room/housekeeping consequence → minibar → waitlist → groups/blocks → desk tasks → front-desk supplies/requisition → Front Office facts/metrics.

All write-heavy certification cases were executed in transactions and rolled back unless explicitly identified as historical read-only evidence.

### Backend verified / passed
- **Front Office direct reservation:** Receptionist-created reservation uses live rate quote/availability and `neo_reservation_create`. Retry with the same idempotency key returned the same reservation; only one reservation row existed.
- **Transport & Transfers:** Guest-created City Transfer tied to the active reservation/property; Nairobi Receptionist confirmed it successfully. A Taveta Receptionist was denied against Nairobi, correctly proving property scope.
- **Room transfer:** Room 102 → 103 updated both reservation and stay; source room became vacant-dirty; destination became occupied; room-move history and housekeeping cleaning task were created.
- **Checkout control:** Unsettled checkout was refused. Owner override required a written reason; forced checkout produced checked-out reservation/stay, under-review folio, vacant-dirty room and checkout workflow event.
- **Waitlist lifecycle:** waiting → offered → converted produced a confirmed reservation and assigned room. New `pms_waitlist_create` RPC was rollback-tested successfully.
- **Groups/Blocks core:** group → room block → rooming row → reservation conversion → pickup count → unused-room release all worked in rollback testing. New `pms_group_create` RPC was rollback-tested successfully.
- **Desk Tasks:** Front Office Manager assigned task to Receptionist; Receptionist progressed and completed their own task with status/progress/completion timestamp persisted.
- **Front Desk Supplies need:** Receptionist reported a need; Front Office Manager acknowledged it. Requisition engine was proven downstream using Owner authority; need linked back to the created Stores requisition.
- **Front Office facts/metrics:** live Nairobi-local facts/metrics resolved arrivals, in-house, room-state, folio, requests and waitlist from canonical data.

### Failed / defects found
1. **Guest request loses stay/room context after check-in**
   - Live function accepted only `checked_in` / `in_house`, while PMS stores `checked-in` / `in-house`.
   - Result before fix: Guest housekeeping request had `reservation_id = NULL`, `room_id = NULL`.
   - **Fix:** `20260924153000_front_office_connected_guards.sql` accepts canonical/legacy aliases and records `stay_id`.
   - **Retest:** rollback-installed patched function returned correct reservation, stay and Room 102 IDs.
   - Classification: **BACKEND VERIFIED FIX** pending matching deployment.

2. **Guest and Front Office quote different price for same inclusive rate plan**
   - Front Office `pms_quote_rate`: Standard Single Room Only = KES 5,500 total, tax treatment inclusive.
   - Guest `neo_guest_room_offers`: same plan/date = KES 6,380 because 16% VAT was added again.
   - **Fix:** Guest offer now carries `tax_treatment` and only adds tax/service for exclusive plans.
   - Classification: **IMPLEMENTED, NOT VERIFIED** pending matching deployment/runtime parity.

3. **Front Office Minibar blocked by inventory permission**
   - `neo_minibar_post` authorised Receptionist at folio layer, but downstream `inventory_apply_movement` rejected with `Not permitted to move stock`.
   - **Fix:** controlled Minibar RPC enables system posting only inside the already-authorised operation and always disables it before return.
   - **Retest:** rollback simulation posted 1 House Soda, Beverage Store stock 718 → 717 exactly once, folio received exactly KES 300.
   - Classification: **BACKEND VERIFIED FIX** pending deployment.

4. **Group deposit crashes before payment creation**
   - Defect A: `_group::text` written into UUID `payments.source_record_id`.
   - Defect B: `ON CONFLICT (organization_id,idempotency_key)` omitted the predicate required by the live partial unique index.
   - **Fix:** use UUID `_group` and `ON CONFLICT (...) WHERE idempotency_key IS NOT NULL DO NOTHING`.
   - Runtime payment retest is currently blocked by the tool financial-write safety guard.
   - Classification: **IMPLEMENTED, NOT VERIFIED / TOOL-BLOCKED**.

5. **Front Office Manager cannot raise Stores requisition despite UI capability**
   - Bakari Kilonzo has `pms.requisitions.create = true`; live RPC checked only Restaurant/Stores capabilities and returned `Not permitted to raise a requisition`.
   - **Fix:** RPC now recognises PMS/Front Office requisition capability without granting general stock-movement authority.
   - Downstream requisition engine independently proven with Owner authority.
   - Classification: **IMPLEMENTED, NOT VERIFIED** pending deployment/retest as Front Office Manager.

6. **Waitlist UI was management-only**
   - Backend lifecycle worked, but source page had Offer/Convert/Close only and Availability merely navigated to it.
   - **Fix:** added Add-to-Waitlist dialog + authenticated `pms_waitlist_create` RPC; RPC rollback-tested successfully.
   - Classification: **BACKEND VERIFIED / UI IMPLEMENTED, NOT RENDER-VERIFIED**.

7. **Groups page had no creation action**
   - Backend group/block lifecycle existed, but empty UI offered no New Group path.
   - **Fix:** added New Group dialog + authenticated `pms_group_create` RPC; RPC rollback-tested successfully.
   - Classification: **BACKEND VERIFIED / UI IMPLEMENTED, NOT RENDER-VERIFIED**.

### Source regression coverage added
- `src/lib/__tests__/front-office-connected-contract.test.ts`
- Contract covers checked-in Guest request linkage, inclusive-tax parity, controlled minibar posting, Front Office requisition capability, group-deposit UUID/idempotency, and Waitlist/Group create actions.

### Environment limitation
Latest source typecheck/build remains **BLOCKED — ENVIRONMENT** in this audit container because the local dependency tree lacks `vite/client` types and the npm registry has previously been unreachable. This is not recorded as PASS.

### Front Office certification state
**LIVE PARTIAL / BACKEND VERIFIED WITH DEPLOYMENT-PENDING FIXES**

The connected PMS core is functioning, but final production certification requires deployment of the new migration/source, re-running the fixed Front Office Manager/group-deposit paths, and rendered-browser verification of the new creation dialogs and route behavior.

## 2026-09-24 — Restaurant / Bar / Kitchen / Pastry connected certification

### LIVE / rollback-safe backend results
- Waiter Amina Chebet created a real three-station bill shape with Beef Burger + Extra Cheese modifier, House Soda, and White Forest Slice.
- `neo_pos_send_to_kitchen` created exactly 3 station tickets: Grill, Main Bar, Pastry. Retrying the same send attempt created 0 duplicates and reused all 3 ticket items.
- Main Bar: David Kamau accepted → preparing → ready. Pastry: Nuru Mwanaheri advanced accepted → preparing → ready. Waiter served both; POS items and station tickets converged to `served`; order converged to `served`, payment remained unpaid as expected.
- Direct-stock void policy verified on House Soda: served → cancel-pending → voided produced exactly one +1 stock reversal and marked the inventory posting event `reversed`.
- Prepared recipe void policy verified on Beef Burger: no stock reversal; exactly one `prepared-void` waste record created in `pending-review`.
- Pastry production verified: plan → assigned item → in-preparation → ready → completed → produced/sold/wasted reconciliation (12 / 10 / 2).
- Custom cake verified: create → assign → in-preparation → decorating → ready → collected.
- Pastry wastage verified: Nuru recorded; Owner independently approved.

### Confirmed live defects / recovery items
- POS/KDS reconciliation is currently unhealthy because of historical stale state: one voided POS item still active in KDS; two served POS items still `new` in KDS. Fresh certification orders did not reproduce the mismatch, so classify as RECOVERY / HISTORICAL RECONCILIATION REQUIRED rather than current routing failure.
- Kitchen routing health: 2 / 80 menu items missing routing and 1 ticket has no station. Grill has no assigned worker in `user_stations`; BUSINESS CONFIGURATION REQUIRED.
- Bar dashboard shows historical delayed/unassigned queue backlog and negative quantities for four Bar Store certification items; these are configuration/data cleanup blockers, not a fresh-order routing failure.
- Pastry → Stores requisition fails live with `function min(uuid) does not exist`. Same UUID aggregation bug exists in Kitchen and Security requisition wrappers.

### Source correction added
- `20260924154500_department_requisition_family_guards.sql`
  - removes invalid `min(uuid)` aggregation;
  - refuses mixed-property / mixed-department need selections;
  - permits the intended Kitchen, Pastry, Security and Front Office authorities to hand off controlled requisitions to Stores;
  - updates Kitchen / Pastry / Security wrapper functions to use a shared safe need-lines resolver.

### Still not live-certified in this cluster
- cash settlement write was blocked by the external tool safety guard during this pass; existing cash/till functions remain backend-inspected and previously dry-run tested, but this specific fresh F&B payment path is not newly LIVE VERIFIED here.
- provider/card/M-Pesa settlement remains EXTERNAL DEPENDENCY / configuration-gated.
- historical KDS backlog repair action still needs an explicit recovery execution, followed by reconciliation returning healthy.

## Operations certification — Housekeeping / Laundry / Maintenance / Grounds / Assets — 2026-09-24

### Housekeeping
- Nairobi departure-cleaning template exists with 10 mandatory checklist steps and supervisor inspection required.
- Duplicate-open-job guard correctly protected an existing Room 104 cleaning job instead of creating a second checkout-cleaning task.
- `hk_stale_job_candidates(SCN,24h)` currently returns no stale Nairobi jobs.
- Fresh full lifecycle transaction attempts were connector-cancelled before completion; retain existing protected housekeeping evidence and classify fresh end-to-end worker cycle as LIVE PARTIAL / connector-blocked rather than passed.

### Laundry
- Savanna Crown Nairobi has no active hotel linen master items: BUSINESS CONFIGURATION REQUIRED for hotel-linen batch certification.
- Savanna `LAU-2026-000002` is malformed: delivered status with no delivered timestamp/confirmer, no reservation/room/folio, and blocked posting.
- Live retry exposed a defect: Finance posting was attempted before validating a guest folio charge, then `neo_laundry_posting_invariant` rejected `posted` without a folio line.
- Forward migration `20260924160000_laundry_retry_preflight_guard.sql` now preflights folio + folio-line. Rollback proof on the malformed order returned `missing_folio_charge` and safely retained `posting_status=blocked`.

### Maintenance
- Live technician picker returned zero although Nairobi has eligible Maintenance & Landscaping staff. Root cause was the `neo_scoped_workers` datasource.
- Forward migration `20260924161500_maintenance_assignment_create_guards.sql` replaces the picker datasource and filters to eligible Maintenance department/maintenance-role workers. Rollback proof returns exactly Wycliffe Otieno, Bakari Muthoni, Faith Ochieng and Mercy Barasa.
- Work-order creation failed when `cost_estimate` was omitted because the table requires NOT NULL. Migration adds default/guard `0`.
- Part issue failed when valuation returned NULL because `work_order_parts.unit_cost` is NOT NULL. `20260924162500_maintenance_part_cost_guard.sql` safely defaults unvalued part cost to 0 rather than aborting the repair.
- Actual app-style maintenance lifecycle was exercised rollback-only with Room 115 + one SCN LED bulb: assigned officer accepted -> in-progress -> consumed exactly one bulb -> completed; manager moved completed -> awaiting-verification -> closed. Final room state was maintenance `operational`, `vacant-dirty`, `sellable=false`, which correctly requires Housekeeping before sale.
- Legacy `neo_maint_job_advance` used non-canonical `verified` / `on-hold` states. `20260924163500_maintenance_status_contract_alignment.sql` aligns it to the canonical work-order state machine and fixes previous-status history capture. My Jobs UI now uses waiting-parts / waiting-supplier instead of invalid on-hold.

### Grounds
- Savanna Nairobi has no configured Grounds Areas or gardening equipment assets: BUSINESS CONFIGURATION REQUIRED for area/equipment scheduling.
- Free-label grounds flow passed rollback-only: Maintenance Manager created/assigned -> officer started -> completed; assignee, branch, timestamps and completion notes persisted correctly.

### Assets
- Nairobi asset register is populated (generator, water pump, walk-in refrigerator, coffee machine, network router) with tags, criticality, purchase values and planned service dates.
- Asset-linked preventive maintenance tested rollback-only on `SCN-AST-002` Main Water Pump: completion created one `asset_service_history` row and updated `last_service_date` while preserving `next_service_date`.

## Events & Conferences / Banqueting certification — 24 Sep 2026

- Event booking create/confirm: AUTOMATED BACKEND VERIFIED in rollback transactions using Sales & Events Manager.
- Venue/BEO: Conference Hall booking confirmed; BEO published and locked; 3 department requirements created; Housekeeping event-preparation handoff created.
- Banqueting staff/task controls: assigned staff can progress own task; unassigned user denied.
- Event billing build: KES 90,000 agreed value produced one billing line and built billing state.
- Maker/checker: Sales & Events Manager lacks billing approval; Owner authority used for finalisation path.
- Close-out defect found: neo_event_close_out attempted blocker=NULL against NOT NULL event_department_requirements.blocker.
- Fix added: 20260924165000_event_closeout_blocker_guard.sql; rollback verification on EVT-SCN-2026-000001 preserved finalised billing, KES 50,000 paid, KES 52,000 outstanding, closed 3/3 department handoffs, status completed.
- No fake payment/provider success claimed.
