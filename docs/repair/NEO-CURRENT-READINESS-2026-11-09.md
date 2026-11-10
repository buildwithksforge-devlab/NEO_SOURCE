# NEØ queue repairs — 9 November 2026

Three more queue records have tested, deployed source repairs: B05 new-station display integration, L09 staff-dashboard access/loading boundaries, and L10 Integration Centre evidence handling. Their wider workflow acceptance remains open.

- Full offline regression: **4141 passed, zero failed, 155 skipped**. All original 3,667 unique passing tests and all 4,055 unique passing checks from the previous deployed suite (4,065 total passes) are retained.
- 76 new tests since the previous release: dashboard 38, station classification/cache 14, actual scoped station hook 4, integration evidence 20. These are included in the full total.
- Final TypeScript, production build, source/build identity comparison and production server smoke passed.
- Deployed source **a7909d0c559a0935**, Cloudflare version **5234c00d-f8d2-42c2-a04a-0024769787ad**, to [existing neo-preview](https://neo-preview.neo-hospitality.workers.dev). HTTP startup/auth retest passed. Previous rollback version: 97d6c983-a57c-4c64-8d6c-39067a103527.

| Record | Change | Remaining acceptance |
|---|---|---|
| B05 | Configured department identifies new production stations with arbitrary names; station changes refresh all six real caches. Server visibility and assignment limits remain enforced. | Real station routing, PIN authentication and production handoff. |
| L09 | Waits for resolved identity/access; scopes caches to organisation/worker/property/authority; validates payload; shows denial instead of a false empty day. | Reported intermittent scenario under actual staff role and session changes. |
| L10 | Checks authority before a provider probe; confirms saved evidence before success; key presence cannot certify a connection; callback proof requires its specific invalid-token rejection. | Configured provider account, actual delivery and saved live evidence. |

Queue: **18 queued, 33 partial/in progress, 5 awaiting deployment/components, 46 awaiting workflow acceptance**, plus one partially verified and one awaiting print-agent deployment. Two specific records are fully closed; 104 remain acceptance-open of the fixed 106. Acceptance-open includes deployed fixes and is not a count of untouched defects.

The first combined regression found the new current_org_id call missing from RPC_MANIFEST; its authenticated declaration was added, targeted checks passed and the fresh full run above passed. The earlier station static refresh check was resolved without weakening its assertions. Neither earlier failing run is reported as green.

The old laundry installer error was already resolved by inspecting live definitions, adapting the repair, retesting and verifying the later installation. Do not rerun the mismatched bundle.

Next confirmed source defect: Go-Live readiness/menu request errors currently fall through to empty-state messages. L11 remains explicitly open for error handling, response validation, identity-scoped caches and inspection of the actual readiness gates. Laundry delivery/folio idempotency, supplier receiving/matching, finance policy and the remaining business-day chains also remain open.

No new database migration, order/payment/stock transaction, email or SMS was executed in this batch. Provider tests were synthetic. Physical printer output and authenticated full-day workflows are not certified by HTTP smoke tests. The source remains locally modified; this pass does not claim a Git commit/push.
