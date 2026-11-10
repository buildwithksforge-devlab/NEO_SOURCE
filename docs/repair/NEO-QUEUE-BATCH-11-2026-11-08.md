# NEØ queue batch 11 — GL replay evidence

**34 queued · 23 active/partial · 21 awaiting deployment/retest · 25 awaiting workflow tests.** One print-agent record awaits deployment, one is partially verified, and one is fully verified.

Three original finance records gained source fixes: A05, J01 and J05.

## Defects reproduced and fixed

The actual reviewed GL helper returned success for an existing draft without posting it, and returned success for a posted journal whose lines were unbalanced. Savannah replay now checks the current organization/property scope and existing source/property/currency/accounting-date identity. It requires finite positive balanced ledger totals and organization-owned lines/accounts. A posted journal must agree with its header totals. A draft/approved journal must match the requested account amounts and then pass through the unchanged fin_post_journal engine. Closed periods and inactive/non-postable accounts remain valid posting blocks. Posting context is restored after failure.

A per-organization/source advisory lock precedes journal lookup. Literal correction-prefix matching avoids wildcard lookalikes; reversed originals can create one correction and later replays reuse it. Invalid input amounts, two-sided lines and mismatched drafts are refused. Existing execute privileges and valid protected other-organization replay behavior are retained.

## Validation

**39 isolated PostgreSQL checks passed**, using the actual reviewed GL and journal posting definitions. Cases include original defect reproductions, eligible draft/approved posting, no duplication, period/account denial, stale amounts/date/currency/property, foreign lines/accounts, finite quantities, header/line disagreement, empty drafts, context restoration, normal fresh posting, corrections, literal prefixes, privileges, unchanged neighboring engine, guarded installer and read-only postcheck. Period/account data are synthetic and numbering/scope helpers are modeled. Sequential replay is tested; multi-session races remain separate.

**58 existing finance lifecycle/journal-resolution regressions passed, zero failures/skips.** Application source did not change; broad prior validation remains 3,890 passes, zero failures, 155 skipped, TypeScript/build smoke passed.

## Installation boundary

SQL 95 and migration 20261108160000_gl_replay_evidence.sql are local code-only candidates. The installer refuses unexpected GL or fin_post_journal fingerprints. SQL 96 reads installed code only. Installation itself does not retry drafts, create journals, update receipts/payments, reopen periods or rewrite history. No operational database was accessed or changed during this batch. Full financial workflow acceptance remains open.
