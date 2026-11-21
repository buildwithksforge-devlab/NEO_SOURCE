# NEØ queue batch 10 — stock consumption boundaries

Seven queued records moved into active repair and one previously active record gained more tested fixes.

## Concrete fixes

The actual POS consumption function now rejects null, zero, negative, NaN and infinite sold quantities, invalid configured per-sale quantities/yields, empty recipe expansions, invalid component quantities/units/kinds, and missing or foreign organization mappings. A nullable recipe field no longer hides a real active recipe in Savannah mode inference. Scoped calls reject a foreign workspace/property context. A transaction advisory lock precedes the existing posting lookup. No historical mappings, stock quantities, receipts or recipe rows are changed by installation. Valid protected other-organization consumption behavior and existing authenticated function permissions are retained.

## Validation and limits

54 isolated PostgreSQL checks passed, including three original defect reproductions, direct-stock replay, recipe scaling, use/waste separation, volume conversion, prepared-batch scaling, rollback after a later invalid component, lifecycle exclusions, store-mapping refusal, organization/property denial, retained permissions, actual guarded installer and read-only code postcheck.

The core is the actual source function; expansion, stock movement and batch dependencies are modeled. These checks do not certify physical stock, complete sale/service/payment/void flows or multi-session races. SQL 93 refuses an unexpected existing definition. SQL 94 verifies installed code only. The local migration is 20261108150000_pos_consumption_boundaries.sql. Nothing was deployed or applied to an operational database.

Application source was unchanged in this batch; the previous full validation remains 3,890 passed, zero failed, 155 skipped, TypeScript/build smoke passed. The additional focused recipe/stock regression passed **42 tests, zero failures** after the initial approval-service usage interruption was resolved on retry.

## Records advanced

- **NEO-BKL-C01**: Actual consumption core now rejects invalid sold quantities, invalid recipe yields, missing/foreign stock and empty expansions; no zero-line success posting. Ingredient movement dependencies modeled in 54 isolated SQL checks; full inventory acceptance remains open.
- **NEO-BKL-C02**: Real active recipes are detected even with nullable fields; valid recipe amounts scale by sold quantity/yield, with invalid yields and components refused. Actual coffee mappings and physical stock still require separate evidence.
- **NEO-BKL-C03**: Direct-stock quantities must be finite and positive; volume conversion and direct replay are tested against the actual core with modeled movement dependencies. Physical beer/bottle inventory remains unverified.
- **NEO-BKL-C05**: A per-item transaction advisory lock precedes the posted-event lookup; repeated calls reuse the posting and do not consume twice in isolated tests. Multi-session races and full service/payment/void paths remain open.
- **NEO-BKL-B09**: Shared coffee/beer consumption boundary fixes cover direct-stock, recipe, use/waste and volume branches. No historical ingredient mappings or stock balances rewritten.
- **NEO-BKL-A06**: Consumption input failure cannot leave a success receipt or partial earlier movement in the isolated core tests; valid replay is idempotent. Full bill closure and real movement integration remain open.
- **NEO-BKL-B10**: Prepared-batch amount converts into recipe yield units before canonical ingredient consumption; invalid later expansion rolls back modeled prepared-batch usage. Actual pastry production/cross-station reconciliation remains open.
- **NEO-BKL-C07**: Additional actual-core checks enforce finite positive yields/per-sale quantities, detect nullable active recipes and verify batch scaling. Recipe expansion/movement dependencies are modeled; production acceptance remains open.

**37 queued · 20 actively/partially repaired · 21 awaiting deployment/retest · 25 awaiting workflow tests.** A further print-agent record awaits deployment, one is partially verified and one is fully verified.

