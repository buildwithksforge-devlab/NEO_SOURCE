# M-Pesa, stock explanations and receiving release — 13 November 2026

Deployed to the existing neo-preview Worker: f3e3b209-9fe5-4280-b817-7549be8c43e7.

## Changes

- Payment initiation, reconciliation and callbacks use the existing authorized managed backend. No service-role credential was retrieved or embedded. Manual redirects are checked explicitly for Cloudflare compatibility; the uncertain-attempt Release command remains blocked.
- Provider compact transaction dates are parsed correctly. The user installed the shared result-RPC text-date contract, verified-provider prepayment guard and stock-shortfall explanations; all installation checks matched. A provider-confirmed staff draft remains unsent until staff explicitly send it.
- Existing pending M-Pesa payments expose Check Safaricom separately from Manual verification. Opening recovery finds the existing attempt rather than sending another prompt. POS, delivery, guest folio and reservation-deposit paths share the confirmation handling.
- The generic Daraja connection diagnostic now uses the existing managed endpoint while preserving local authorization and diagnostic evidence checks.
- Clicking an unavailable menu item shows its actual stock shortfall without adding it to the bill; lookup failures also block adding it.
- The deployed receiving approval routine previously returned approved without a GRN while the app expected atomic posting. The installed correction posts atomically only when the independent reviewer also has existing receiving-posting authority. Review-only approval waits for a receiving manager. Stock-location validation now rejects shared/wrong-property stores before count submission rather than at GRN creation. Virtual-only count posting is blocked. No permissions or RLS policies were relaxed.
- Receiving screens distinguish pending approval, pending GRN posting, stock received and pending Finance accrual. They no longer portray a saved review-only approval as a failed GRN creation.

## Verification

323 focused regression tests passed, zero failed or skipped. Full TypeScript, production build and built-server smoke checks passed. The exact receiving installer passed 24 isolated PostgreSQL assertions, including exported old-code reproduction, successful GRN handoff, independent permissions, rollback, replay and definition-drift refusal. Inventory/Finance boundary behavior in that isolated fixture is modeled; it is not live stock acceptance.

All seven deployed payment handlers rejected fabricated sessions through the managed backend. A fabricated callback token and staff-device proof were rejected. Home/auth returned HTTP200 with build identity and no-store. Four deployed asset responses matched the local build byte-for-byte: receiving queue, independent review, M-Pesa recovery dialog and POS stock explanation.

Evidence is in the shared Codex workspace under work/mpesa-repair (all-entry-confirmation-tests.json, all-entry-build-checks.json, worker-auth-probe.json, worker-live-surfaces.json, deployed-fix-assets.json, corrected-bridge-deploy.log) and work/receiving-repair (test-results.json, installed-confirmation.json).

## Remaining acceptance

The user confirmed a real KES51 debit and successful Safaricom callbacks. NEØ has not yet credited that collection: callback date parsing originally rejected it, and the associated draft was subsequently emptied. Targeted recovery refused the changed bill safely. Restore the original Ginger Cookie sale only if its saved historical snapshot can be located, then reconcile the existing collection once. Do not send another STK prompt or mark the empty bill paid. Recovery and the pending-attempt line-removal protection remain open.

A live receiving-to-GRN transaction still needs verification using a legitimate delivery and independently authorized staff. No live receiving count was approved or stock moved by the agent. No claim is made that every department is fully accepted.

Installed SQL under supabase/repair/2026-11-13-mpesa is an evidence archive, not a request to rerun it. The private one-payment recovery SQL is deliberately excluded. No GitHub push or history rewrite was performed by the agent.
