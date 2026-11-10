# Reviewed stale-view findings

Source-confirmed gaps and explicitly reviewed false positives. These are linked follow-ups, not additional closed issues or a replacement for authenticated/runtime tests.

## SV-001 — Repaired and deployed in batch 25

PMS/deposit/cash success refreshed only some caches

Shared refresh now includes reservation, finance, register, folio projection, payment lifecycle, audit and till. Deployed as 1e122a207782d3fa. Authenticated workflow acceptance remains separate.

## SV-002 — Repaired and deployed in batch 25

Payment-register key omitted worker/organization/authority boundaries

Identity key and ready-access gate added; 43 focused checks pass.

## SV-003 — Confirmed gap; SQL 137 installed

Reservation deposits were absent from payment-attempt-only register

Read-only projection now includes deposits and deduplicates linked payment/event representations; 31 database checks pass.

## SV-004 — Repaired and deployed in batch 26; authenticated acceptance pending

Station stock has no explicit refresh root, polling or live subscription

Connect actual stock changes and bounded refresh; test station/store changes and remote worker updates. Batch 26: visible 15-second stock refresh, current-assignment station selection, shared durable cash/payment keys, refusal handling and fresh second-collection amount. 19 final focused app checks pass; SQL 145 installed and verified.

## SV-005 — Repaired and deployed in batch 26; authenticated acceptance pending

Station selection only initializes when empty and can retain a station after property/assignment changes

Derive effective selection from the current authorized station list before querying stores. Batch 26: visible 15-second stock refresh, current-assignment station selection, shared durable cash/payment keys, refusal handling and fresh second-collection amount. 19 final focused app checks pass; SQL 145 installed and verified.

## SV-006 — Repaired and deployed in batch 27

Outbox batch replay creates an invalidator but never calls it on success

Saved replay result is validated; actual posting, lifecycle, outbox, automation and intelligence roots are refreshed. Focused cache tests pass. No live replay performed.

## SV-007 — Repaired and deployed in batch 26; authenticated acceptance pending

PMS cash dialog has an intent key but omits it from the cash request

Carry a stable collection key through cash retries and retain distinct keys for genuine second payments. Batch 26: visible 15-second stock refresh, current-assignment station selection, shared durable cash/payment keys, refusal handling and fresh second-collection amount. 19 final focused app checks pass; SQL 145 installed and verified.

## SV-008 — Repaired and deployed in batch 26; authenticated acceptance pending

PMS payment amount initializes from balance once and is not reset on later openings

Refresh the suggested amount from the latest balance per new collection; preserve failed-intent retry details. Batch 26: visible 15-second stock refresh, current-assignment station selection, shared durable cash/payment keys, refusal handling and fresh second-collection amount. 19 final focused app checks pass; SQL 145 installed and verified.

## SV-009 — Confirmed disconnected command; repair pending

pms_confirm_payment exists in deployed database but has no application caller

Connect authorized confirmation of manually received bank/card tenders with saved reference/evidence; provider-backed confirmation remains distinct.

## SV-010 — Confirmed semantic defect; repair pending

Deposit-state sync labels the reservation Paid when the minimum deposit target is met

SQL 139 confirms minimum deposit is used rather than full quoted stay; 36 paid-label/positive stored-balance review candidates among 96 reservations are not proof of additional money owed.

## SV-011 — Reviewed POS connection; financial remote refresh repaired in batch 27

Provider-intent checkout polls terminal status; POS parent has real-time payment invalidation

Existing POS realtime/intent polling retained. Finance register/lifecycle/folio views now have visible refresh and identity boundaries; fallback selected operational refresh is tested.

## SV-012 — Partial failure candidate; not yet proven defect

Recipe menu item is created before recipe save; the full success path refreshes menu, partial failures require review

Test failed second step and publication/readiness before deciding the repair.

## SV-013 — Reviewed connection; no repair indicated by this flag

Workspace switching clears all queries and reloads the session

Static refresh regex missed clear/reload; not a missing-invalidation defect.

## SV-014 — Reviewed connection; no repair indicated by this flag

Kitchen transitions refresh through onSettled

Direct onSuccess only displays toast; onSettled settles ticket/kitchen/POS queries.

## SV-015 — Reviewed read-only action

Opening a guest document creates a signed URL and access log

No change to the underlying document list, so missing list invalidation is not automatically a defect.

## SV-016 — Reviewed polling connection

Rider location is read through bounded customer polling

Do not invalidate every browser cache on every GPS ping; verify the polling and expiry contract.

