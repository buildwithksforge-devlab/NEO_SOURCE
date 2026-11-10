# Added operational findings — 9 November 2026

These observations extend the existing 106-item queue without declaring new closure or silently changing its denominator.

- Confirmed reservation deposits must appear once in the payment register and related folio/reservation views. Linked D01/J03/FIN-R06. Distinguish deposit receipt, liability and later application; do not count application as a second collection.
- Check-in fails with a reservation record/currency error. Latest supplied schema has no reservations.currency column. Exact calling function/trigger still requires SQL 133 before a guarded patch; no new currency field will be invented to silence the error.
- Automation dashboard: inspect Process pending events authority, replay protection, result/error handling, backlog and outbound controls. The real runner can process business events and communications; do not click it merely as a connection test.
- Provider connections: inspect Check connections authorization, backend configuration and accurate status wording. Configuration presence is different from external authentication or actual delivery. Keep keys server-side.
- M-Pesa: existing Daraja server code supports STK initiation. Merchant C2B notifications and reliable bill matching require a separate verified path. Business-controlled live credentials and reachable HTTPS callbacks are external prerequisites; no secret was requested in chat or generated.

SQL 132 supplied evidence confirms fresh laundry intake function and intake identity columns are absent. It also shows a legacy express rollup multiplies subtotal by 1.5; an intake installer must be tested with that trigger and correctly set resident/room-charge facts. The POS payment-attempt trigger always records a confirmed state with no journal ID; the register reads that stale projection directly. Full evidence-based register repair remains pending.

Confirmed update: SQL 133 identified tg_folio_sync_reservation_payment_status() reading reservation.currency. SQL 134 is now installed and verified (function matches; check-in, currency provider and trigger attachment unchanged). Twenty-seven isolated checks pass, including actual deposit application. A fresh guest check-in is still a separate workflow retest.

SQL 136 confirms reservation deposits are not mirrored into payment_attempts, while event_payments are. Both source families can link a payments row through payment_id, so the unified register repair must deduplicate linked representations. The null status-count result from SQL Editor does not establish that the organization has no deposits: the editor's current_org_id context was not established by that query. No historical records should be backfilled or recollected merely to populate a report.
