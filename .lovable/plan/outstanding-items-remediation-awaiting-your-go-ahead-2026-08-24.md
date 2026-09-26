# Outstanding-Items Remediation (awaiting your go-ahead)

Nothing was changed in this check. The findings report is in chat. If you want the cleanup done, this is the proposed order of work.

## 1. Core defects (code/workflow)
- Make automatic finance posting run through the trusted silent path so operational actors no longer produce "You do not have permission to post journals" failures.
- Collapse the duplicate receipt writers (`laundry` + `laundry_order`, `delivery` + `delivery_order`) to one canonical receipt per source event, and clear stale blocked rows that contradict a posted journal.
- Add a supervised retry surface for failed/blocked receipts (retry, inspect error, mark resolved with reason) instead of silent rows.
- Fix laundry-order creation so a laundry number is always assigned and zero-value orders cannot enter the posting queue.
- Move plaintext provider keys out of `integration_connections.masked_identifier` into secrets, storing only a masked suffix.

## 2. Historical accounting cleanup (auditable, no silent rewrites)
- Post correcting journals (reversal + re-post, never edits) for the tax gross-up on JV-ZSN-2026-000002/4/5/15/17 (AR/revenue overstated by 9,248 total).
- Post reclassification journals moving pre-mapping revenue out of 4090 into 4020/4030/4010 where the source document supports it.
- Retry the two unposted revenue items (LAU-2026-000002 folio charge 2,376 and POS-20260819-4G2PK 5,790) under the fixed VAT logic.

## 3. Tenant configuration / deployment
- Configure the four monitoring checks and a schedule.
- Purge or archive UAT/scratch operational records (7 UAT POS orders, UAT customers/reservation/folio line, zero-value laundry orders, stale draft POS orders) with an audit note.

## 4. External integrations
- Register eTIMS settings, payment provider (M-Pesa/Daraja), and per-tenant email/AI connections in production environment.

## Technical notes
- All accounting corrections go through `neo_finance_post_txn` / journal reversal routines; no direct UPDATE of `journal_entry_lines`.
- Any schema/function change ships with targeted tests plus the full regression suite.
