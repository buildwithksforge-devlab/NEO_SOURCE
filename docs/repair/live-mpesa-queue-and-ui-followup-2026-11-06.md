# Live M-PESA queue and UI follow-up — 6 November 2026

## Verified live

After the user signed in manually, the agent opened https://neo-preview.neo-hospitality.workers.dev/finance/payments read-only as Owner / Director at Savanna Crown Nairobi. The M-PESA Till — Delivery Payment Verification panel loaded and displayed: No customer-submitted M-PESA Till references are awaiting Finance verification. The former missing-function error was absent. No Verify/approval/payment controls were used, no claims were created and no operational records were changed. This confirms this account's queue/API path and empty-state UI after the user-installed SQL, not the full payment lifecycle or ordinary-role isolation. STK remains separate and unverified.

## Two additional local source fixes

The browser's actual workspace URL encoded home as a JSON string (home=%221%22). The local outer frame only recognised unquoted home=1, although the route parsed the quoted value and rendered its chooser. isWorkspaceEntrance now accepts both representations of the exact value 1 and still rejects other routes/values. The actual AppShell regression confirms the chooser does not mount the OS sidebar/topbar for the observed quoted URL. This is a layout correction, not a context/permission change.

The Till approval form used Number.isInteger(amount * 100), which incorrectly rejects ordinary valid amounts such as KES 0.29 due to binary floating-point arithmetic. It now validates the entered decimal text, requires positive amounts with at most two fractional digits, and verifies cents survive numeric JSON serialization exactly. Unsafe large amounts, exponents, negatives and excessive decimal places are rejected. The receiving-account requirement, independent merchant checkbox/evidence and confirmed posting response remain mandatory. No installed SQL definitions changed for this UI fix.

45 focused UI assertions passed across the actual payment form, decimal validator, display tools, chooser transitions and outer frame. This is additional to the preceding 32 isolated database installation/workflow checks. Tests use mocked transport and synthetic fixtures; they never contact operations. Typecheck/build status is recorded below after completion. The preceding full offline run remains 3,667 passes / 155 skips; that whole suite was not rerun for this narrow follow-up and must not be reported as a new full-suite result.

The new UI fixes remain local until committed/pushed/deployed through the existing workflow. The installed claim SQL should not be rerun. The original 87/88 outcomes, original 30 regressions and full-day financial close remain tracked; this queue read does not certify any whole business workflow.

## Final source verification

Typecheck passed. Production build/smoke passed: built / and /auth returned HTTP 200 with private/no-store, source identity and local fonts, and no detected ESM/CommonJS interop crash. The 45 focused UI tests passed. No further SQL is needed for these two UI fixes. No source commit, push or deployment was performed for this follow-up.
