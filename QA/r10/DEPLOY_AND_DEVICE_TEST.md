# R11 deployment and device test gate

## Order of operations

1. Promote the tested source revision and the two `20260925` migrations as one reviewed deployment. Record its commit/hash and verify it appears in the live UI. Never treat the ZIP alone as deployment.
2. Confirm the 16 targeted anonymous EXECUTE revocations remain false, authenticated access remains true, the `neo_station_store_readiness` authenticated grant works in `/kitchen/settings`, and the push RLS policies reject cross-user/cross-tenant subscription reads and writes with real JWTs.
3. Generate one VAPID key pair through a trusted environment. Configure `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_VAPID_SUBJECT` and a unique 32+ character `NEO_PUSH_DISPATCH_TOKEN` in server secrets. Do not commit the private key or token. Supply an HTTPS scheduler to POST `/api/internal/worker-push` every minute with its bearer token, then set `NEO_PUSH_DISPATCH_ENABLED=true`. The opt-in control and dispatcher remain off until that switch is enabled. Inspect failed retry counts and expired subscriptions.
4. On a real Android browser and an installed iPhone Home Screen app, sign in as a worker, tap **Enable alerts on this device**, then **Send a test alert**. Lock the device; confirm alert arrival, tap navigation to the correct inbox, retry with app closed, repeat after sign-out and re-login. A queued row or push-service HTTP acceptance is insufficient. Verify unauthorized devices and other tenants cannot see the alert. Test disabling on that device.
5. Design and implement permission-safe fan-out for department, station, and property notifications; current R11 only sends explicit `user_id` notifications. Decide how urgent tasks fall back to a proven channel when a worker declines browser permission or a device is offline.
6. Review all 438 pre-existing queued email/SMS records by tenant and purpose. None should be released automatically. Establish a UTC cutover time after review. Set `NEO_OUTBOUND_ENABLED=true` and `NEO_OUTBOUND_CUTOFF=<reviewed time>` only after a controlled single-message provider test and receipt evidence. The old rows remain for manual disposition. Schedule automation only once retries, provider configuration, and backlog policy are confirmed.
7. Reconcile 70 historical folios and 3 purchase orders missing canonical records with Finance. The corresponding live triggers already exist. Do not use broad status updates to backfill: other triggers and timestamps would fire. Record original IDs, amounts and states, then backfill through an audited, reversible migration with before/after totals.
8. Run full role and mobile matrix against the deployed revision: each signed-in role, cross-tenant/property denial, guest booking/payment/receipt, POS→KDS→folio→journal, procurement→GRN→invoice/AP, rider POD, housekeeping, maintenance, events, refunds, timeouts, network errors, accessibility and real notification delivery. Attach server record IDs and device/browser evidence for every pass.

## Safe rollback

- Keep `NEO_OUTBOUND_ENABLED=false` if provider delivery or queue review fails. Historical messages remain queued for examination.
- Stop the push scheduler first if a device issue is found. Removing the sender configuration or returning 503 stops dispatch without deleting notifications.
- Do not roll back a database migration by dropping the subscription or delivery tables while rows exist. Revoke the dispatcher, preserve the audit rows, investigate, then plan a separately reviewed schema rollback.
