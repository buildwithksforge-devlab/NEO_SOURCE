# Batches 24–25 — check-in currency and connected payment views

Live build 1e122a207782d3fa, version 6968bac2-6e5c-40ca-839f-7649c6e6321e. Previous version d2055ea3-9593-4ef4-85aa-96a47c1bc6d4 is the rollback point.

SQL 134 corrects an earlier folio-status trigger assumption: the live reservation table has no currency column. It uses configured property currency. User postcheck verifies code and unchanged check-in, trigger and currency helper; 27 isolated checks include the actual deposit-application trigger.

SQL 137 makes confirmed deposits visible in the existing Payments register without manufacturing new payment rows. Applied deposits stay one collection; linked general/event representations are deduplicated, refunds remain separate, malformed or conflicting amount evidence fails visibly. User postcheck confirms the installed definition and unchanged collection/check-in routines. Thirty-one isolated database checks pass.

The matching interface is deployed. It labels source deposits without pretending provider confirmation, links them back to their reservation and avoids sending an unmirrored deposit ID to the attempt-verification command. Register caches include organization, worker and effective authority. PMS/deposit/cash mutations refresh reservation, finance, register, folio projection, payment lifecycle, audit and till views together; POS invalidation remains.

Validation: full regression 4,275 passed, zero failed, 155 skipped. All 3,667 original unique passes and all 4,221 prior release unique passes retained. Final focused 43 tests, strict TypeScript, production build, startup smoke and live HTTP build/cache checks pass. No real or synthetic live collection, refund, journal, check-in or physical device output was submitted.

Remaining: SQL 139 confirms minimum-deposit satisfaction can mark a whole reservation Paid; 36 of 96 stored-label/balance conflicts need source review rather than automatic recollection. Pending external-tender confirmation has a database command but no application caller. PMS cash intent and suggested-amount handling, station-stock refresh/selection and unused outbox invalidation are confirmed follow-ups. The source inventory scanned 1,048 files, 725 query hooks and 646 mutation hooks; heuristic flags are not automatically defects.
