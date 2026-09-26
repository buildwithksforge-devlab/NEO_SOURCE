# Operational finality fixes

## Build
- Make rider-shift submission clickable whenever it is not already submitting; validate rider and start/end times on submit, then refresh shifts and dispatch eligibility immediately.
- Harden system-test runs with progress heartbeats, guaranteed failure finalization, one active run per workspace, stale-run recovery, and live history/results polling.
- Add idempotent purchase-order reminder generation every two days for genuinely outstanding deliveries. Resolve supplier and requester emails from stored contacts only, skip missing recipients visibly, and retain delivery/audit evidence.
- Add configurable distance per delivery zone and show clearly labelled zone-distance totals and time-per-kilometre comparisons on the staff rider board. No GPS route will be fabricated.

## Live verification
- Re-test Xavier’s shift form and verify an active shift unlocks assignment for `DEL-2026-000001`; do not create a shift without actual shift times.
- Reconcile the three abandoned test runs from their persisted results as interrupted runs, without marking them passed, then start a fresh isolated run and confirm it finalises.
- Verify reminder eligibility and recipient resolution without sending to invented or missing addresses.

## Payment constraint
- Do not post the KES 52,000 event balance yet. “Yes” is not an amount split, and payment references cannot be chosen or fabricated. The existing payment screen remains available for the actual cash amount, M-Pesa amount, cash receipt reference, and M-Pesa transaction code.

## Technical details
- Keep all database changes additive, tenant/property scoped, RLS protected and audited.
- Derive reminder due dates from the last successful/queued reminder and use idempotency keys to prevent duplicates.
- Zone distance is administrator-configured reference data; metrics display “not configured” until a real distance is entered.
