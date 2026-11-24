# NEØ queue batch 3 — source repair evidence

Codebase-first work. No operational order, payment, stock movement or shift was changed by this batch. These local changes have not been deployed.

## Additional request: NEO-ADD-001 — delete draft order

Implemented a Delete draft order action for authorized staff. It requires a reason and cancels an unused unpaid draft while retaining its records and audit trail. Existing payments, production work, accounting links, room charges or delivery links prevent removal. Private removal markers and parent-row locking protect against subsequent payment and production inserts. The original 106-item queue is unchanged in size.

The server remains authoritative even when the UI considers a draft eligible. Paid or used orders continue through the existing void/refund process.

SQL 83 and the matching migration are code-only installation candidates. They do not remove any order during installation. Do not blanket-push historical migrations. Full deployed-trigger integration and simultaneous-session race testing remain outstanding.

## Other repaired source boundaries

- Station edits now require an organization-scoped saved row before reporting success. Missing or invalid department placement is refused, including property-specific departments on organization-wide stations.
- Recipe previews reject missing units, invalid yields and quantities, negative waste and numeric overflow. Existing valid conversions and rounding remain covered. This does not certify the database stock ledger.

## Completed checks

- Eight targeted suites: 85 passed, six skipped.
- Portable isolated draft-removal database regression: 44 passed. Two reviewed existing order guards were exercised. No operational database connection.

Final validation: TypeScript passed. Production build and server smoke checks passed. Full offline regression: 3,731 passed, zero failed, 155 skipped. All 3,667 baseline passing assertion identities were retained. The initial TypeScript run found a test-only index-signature lookup; it was corrected before the successful rerun. An installation result alone is not full workflow certification.

The original queue remains 1 fully verified item and 105 requiring remaining acceptance evidence. Code progress is tracked separately so further repairs can continue before frontend review.

