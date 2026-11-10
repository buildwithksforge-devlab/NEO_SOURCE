# Batch 23 — cash collections and outstanding bills

Deployed build: 8a1337497fad6597. Cloudflare version: d2055ea3-9593-4ef4-85aa-96a47c1bc6d4. Preview: https://neo-preview.neo-hospitality.workers.dev. Previous version for rollback: c84baa49-70b4-4281-b7c8-70a09c5e714a.

Changes: routed cash collections no longer reuse the bill reference as a unique provider reference; the original cash-request reference remains. Tender and change are captured before direct or later cashier confirmation. Same collection key cannot hide a changed amount/tender. Existing five-argument callers remain compatible. Partly paid legacy Paid-state bills remain visible in Open with an outstanding warning. Payment mutations refresh the separate Payments register. No historical money/state was rewritten.

Database installation: user results confirm SQL 128 and SQL 130 definitions match; anonymous access to the new tender entry point is denied. SQL 131 now reports a missing installation cleanly rather than throwing.

Validation: 52 isolated cash checks (including the 36 reference-identity checks); 23 new application tests; full regression 4,232 passed, zero failed, 155 skipped; all 3,667 original and 4,198 batch-22 unique passing tests retained. TypeScript/build/startup smoke passed. HTTP startup, auth and protected client shell serve expected identity with private/no-store. No fresh authenticated payment, device paper output or provider transaction was submitted.

Limits: actual fresh collection/receipt acceptance remains open. Receipt layout/timezone, mixed-tender GL distribution, deposit visibility and late register journal evidence remain separate repairs.

Next confirmed defect: SQL 133 identifies folio status trigger reading nonexistent reservation.currency. SQL 134 corrects it using property currency; 27 isolated checks pass, including actual deposit-application trigger. Installation pending. Other latest findings are tracked in NEO-ADDED-OPERATIONS-FINDINGS-2026-11-09.md.
