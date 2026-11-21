# Queue batch 2 — 7 November 2026

## Implemented changes

| Queue references | Change | Current evidence | Remaining gate |
|---|---|---|---|
| A02, A03, A08 | Older already-Paid orders can close after every item becomes terminal. NULL/unknown item status counts as unfinished. | 17 isolated PostgreSQL checks reproduce the old failure and verify the new transition. User SQL 82 confirms the new engine and eight unchanged neighboring functions. Installation changed code only. | A normal authorised service-to-close workflow with deployed triggers, stock, receipt and journal evidence; no synthetic real-hotel service completion. |
| A01, A04, J02 | POS till preview requests the actual order's property, and cash requests are blocked while the property/till lookup is missing/loading/failed. | Source wiring and payment contracts pass. SQL 79 found zero missing/cross-org/cross-property/out-of-window shift links among 11 scoped payments. | Deploy UI and verify ordinary cashier/role routing. This does not certify every till/shift or fix an old shift by changing its history. |
| L07 | Manual payment-confirm controls use pos/payments/manual-confirm, matching the backend, instead of order approval. A retained choice is blocked if authority disappears. | Actual permission-resolver and source-wiring regression checks pass; backend grants unchanged. | Deployed allowed/denied UI checks and broader staff role coverage. |
| R02, L08 | Printer launcher supports token-free Wi-Fi discovery, native installed-printer discovery without requiring Node first, and actionable missing-config guidance. | 17 agent/CLI tests pass. Actual PowerShell -Discover network found Kyocera TASKalfa 4053ci at 192.168.1.245, advertised IPP and RAW endpoints. No print data sent. | Pair/run updated property agent; verify a compatible printer and physical receipt/ticket. RAW reachability is not ESC/POS thermal compatibility. |
| L03 | New roster assignments resolve template times in the configured property timezone. Overnight shifts end on the next property calendar date. | Six converter tests cover Nairobi, fractional offsets/seconds, overnight/year boundary, DST offsets and ambiguous/missing clock times, invalid dates/zones and zero-length shifts. | Deploy UI, verify property-local assignment/display under intended roles. Existing schedules were not rewritten. Production deadline offset L04 remains separately open. |

## Validation and limits

- 44 targeted POS/roster assertions passed, including existing settlement/permission/service contract checks.
- 17 agent/discovery checks passed, including the new token-free CLI dispatch and rejection checks.
- 17 isolated closure database checks passed from a portable test script in the actual source. The fixture reproduces all nine supplied deployed definition fingerprints before installation; no operational connection is used.
- Final TypeScript check, production build and built-server smoke passed. The built root and auth pages return HTTP 200 with private/no-store, source identity and local-font guards.
- A full offline regression suite was started to compare with the earlier 3,667-pass source baseline. Its final result is appended below when complete; targeted counts are not substituted for that run.
- Ordinary role UI actions, actual concurrent database sessions, full trigger/inventory/journal integration and physical paper are not established by static/source or isolated helper tests.
- The inspected backend branch helper allows technical scope; that differs from an earlier fixture's intended operational restriction and requires a separate role/access review. No broadened access or shared-helper change was introduced here.

## Source versus operational state

The closure engine code is installed and postchecked. No current order was reconciled/closed and no cash/payment/stock transaction was initiated by the agent. The payment UI, roster and launcher changes are local source changes, not a confirmed Cloudflare deployment. The property print agent is not certified paired/running by this batch. The existing database, storage, authentication broker and Worker address remain the architecture.

SQL 80 is the code-only guarded installation; SQL 81 is the read-only postcheck; SQL 82 combines them. The user has already confirmed successful SQL 82 installation. Do not rerun it or the older staff/PIN migrations. No blanket database push is appropriate.

## Token-free local discovery

From the existing source checkout in PowerShell:

```powershell
$neoRuntime = 'C:\Users\Kelvin\Documents\Codex\2026-11-06\files-pasted-by-the-user-ne\work\tooling\node-v22.23.3-win-x64'
.\scripts\start-print-agent.ps1 -NodeDirectory $neoRuntime -Discover network
.\scripts\start-print-agent.ps1 -Discover windows
```

These commands inspect advertised endpoints/installed queues; they do not pair a computer, take payment or print. Bluetooth discovery lists Windows-paired/installed queues and does not perform nearby unpaired radio discovery. Sending jobs still requires private local configuration from Configuration Centre and a supported printer. Keep the secret out of chat and Git; the checkout's default config path is ignored by Git.

## Queue accounting

The baseline remains 106 permanent records: 1 verified complete and 105 with remaining acceptance gates. Queued fell from 72 to 67 as five additional records moved into deployment/retest or workflow testing. The current distribution is in the numbered queue. The completed K01 scope is only the repaired manual Till claim queue error; merchant approvals, STK and complete delivery remain separate.

Implementation progress is recorded even when an item is not fully closed. Do not declare a department ready or subtract original UAT failures based on these test counts.


## Final regression result

Regression evidence totals 3,705 passed assertions, zero unresolved failures and 155 skipped tests. All 3,667 previously passed assertion identities from the preceding display-flow baseline remain passed. The initial full run had 3,704 passes and one failure: a receipt source-contract assertion incorrectly counted every branchId binding in the route after PaymentDialog gained its own property. That test now checks the two SendToPrinterButton receipt bindings directly. Its focused five-test suite passed; application source was unchanged between the full run and focused rerun. The evidence JSON records both runs and the merged latest-per-suite result; no second full run is claimed.

Queue baseline remains 106 / 1 verified complete / 105 remaining. Five additional records have moved from queued into deployment/retest or workflow testing. Do not rerun SQL 82 after the confirmed installation.

