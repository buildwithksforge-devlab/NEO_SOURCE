# POS and folio reporting repair — SQL Editor run order

SQL 75 replaces one reporting function under exact deployed-code guards. It writes no hotel, payment, receipt or journal records. It corrects Savannah POS and folio expected net revenue; it does not certify other streams. Other organisations retain the existing calculation. No blanket migration push.

1. Copy and run the complete 75_APPLY_POS_FOLIO_REVENUE_REPORTING.sql in the same existing SQL Editor. If a guard fails, preserve the error and stop; do not delete guards.
2. Run 76_READ_ONLY_REVENUE_REPORTING_POSTCHECK.sql. All five reported booleans should be true. Share its single JSON result.
3. Refresh Finance Posting for November 1–7. Review POS and Folio net source/ledger totals and remaining explanations. Real remaining differences must be investigated, not zeroed or bulk-posted.

This does not rerun any staff/PIN or earlier financial recovery migration. It does not reopen periods or change service status. The earlier three metadata recoveries and catering journal remain separately verified.

Test evidence: 45 isolated assertions passed from the portable script in the actual source: 36 earlier accounting checks plus nine reporting regressions covering immutability, inclusion of posted sources, net amounts, no room-transfer duplication, unfinished-source exclusion, property/date/permission checks, foreign currency rejection and more than 500 sources. The actual installed prerequisite fingerprints were reproduced before guarded installation in the fixture.

The report contract lacks a currency column; foreign-currency standalone POS sources fail visibly pending verified KES conversion. Other modules remain explicitly legacy/unverified and must not be described as certified revenue. This scoped repair does not finish the financial controls brief or certify departments.