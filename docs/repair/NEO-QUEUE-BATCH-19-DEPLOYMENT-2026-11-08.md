# NEØ batch 19 — code repairs, deployment and retesting

The existing `neo-preview` Worker now serves tested source `fc9e4adcd8389bde`, Cloudflare version `97d6c983-a57c-4c64-8d6c-39067a103527`. The protected Worker/account checks passed before upload; current variables were retained. The previous version for rollback is `9366124a-a143-460a-b0af-054cac170a75`, also recorded in `NEO-WEB-RELEASE-PREFLIGHT-2026-11-08.json`.

The release was deployed from the existing local working tree. This pass did not commit or push GitHub. The build fingerprint includes the actual tracked and untracked application/source files; the live fingerprint matches the tested local build.

## Application repair

The main Tasks page omitted the selected property even though worker assignment requires it. It now validates and persists that property. Front Office, Delivery, Stores, Marketing and Procurement shortcuts require valid context and assignment before inserting, then verify the returned saved task ID, organization, property, department, worker and status. Unknown or mismatched results cannot trigger a success notification. The main page retains deliberate unassigned department-queue tasks.

## Database deployment

Nineteen function definitions were deployed and verified against their tested fingerprints:

- Document payload: one organization boundary added to the actual installed function, preserving fiscal, payment and payslip branches.
- Journal replay, stock count completeness, store issue/return, direct POS capture and four routed-cash functions: eight functions.
- Live-adapted laundry completion/batch synchronization: two functions.
- Safe unused-draft removal and its write guard: two functions. Removal is cancellation with retained history, not physical deletion.
- Event requirement ownership: one private trigger helper.
- Folio-to-reservation status: one function and its verified trigger.
- Room state/availability/search: three functions.
- Live-adapted POS consumption: one function.

The first combined workflow attempt stopped at the laundry fingerprint guard and rolled back. Read-only inspection showed that live laundry already had an all-batches safeguard missing from the older source. The revised repair preserves it and computes readiness from the least advanced scoped active batch. Held/terminal orders remain unchanged; invalid priced totals are refused. The consumption difference was isolated to three movement-note encoding strings; those live bytes were retained while applying the tested boundary changes. No definition guard was bypassed.

An automatic approval check initially rejected the SQL editor's DELETE warning. Statement inspection established that the only DELETE keyword was `ON DELETE RESTRICT`, with no top-level data deletion or mutating guard block. The later inspected code-only confirmation completed successfully.

No existing payment, journal, period, service state, stock balance or task was changed by these function installations. They govern future operational commands.

## Exact QA catalog cleanup

SQL 103 unpublished/disabled only the two confirmed QA products under exact ID/name/company/property/state guards and wrote their audit entries. SQL 104 verified both saved states and omission from all three public channels. A fresh anonymous check returned 25 delivery, 25 pickup and 25 room-service items, 26 unique products, and no QA/test candidates. M02 is now acceptance-verified. Prices, product IDs and history were retained.

## Validation and limits

- Fresh full application suite: **4,065 passed, zero failed, 155 skipped**.
- All original **3,667** unique passes and the preceding application suite's **4,034** unique passes retained.
- TypeScript, production build, production-server smoke and source-identity comparison passed.
- Fresh isolated SQL checks: document **12**, live laundry **22**, live consumption **54**.
- New task checks: **21**, already included in the full application total.
- The initial broad run had one slow filesystem-contract failure; the unchanged focused check passed in 1,133 ms. A fresh full run with a 30-second test limit passed all assertions.
- Live `/` and `/auth` return HTTP 200 with private/no-store and the expected build ID. Browser sign-in renders without errors or overflow. A signed-out order-page visit correctly reaches `/auth?redirect=%2Fpos%2Forders` through the documented client-only route guard.

Actual employee login, independent role actions, full department workflows, physical stock/printers, owner-configured finance policies and external provider inbox proof remain separate acceptance work. The source sweep and the remaining queued/partial implementation work are not declared complete.

Current queue: **21 queued, 30 partial, 5 awaiting deployment/components, 46 awaiting workflow acceptance, 2 fully verified, 1 partially verified and 1 print-agent deployment record**.

Do not rerun the old combined SQL 111 or blanket-push historical migrations. The actual deployed revisions and postchecks are recorded in the `NEO-LIVE-*-2026-11-08.json` files and the guarded SQL packages.

