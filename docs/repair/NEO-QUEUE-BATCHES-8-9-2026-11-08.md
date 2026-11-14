# NEØ queue batches 8–9 — reservation money and room readiness

Eleven original queue records gained tested source fixes. This is implementation progress; no additional full acceptance closure is claimed.

## Reservation money and query boundaries

Reservation detail chooses an active linked folio and exposes booking, selected-folio and all-linked balances separately. Mixed currencies are refused rather than summed. Loading and read failures are explicit. Deposit intent uses the reservation property clock; missing/nonfinite money cannot silently pass the gate. Reservation and availability queries carry organization identity, and invalid calendar/party inputs stop before RPC.

SQL 89 changes the future folio payment-status trigger: all active linked folios contribute, and a pre-arrival deposit below the quote cannot become Paid merely because the current folio has no charges. After-arrival labels retain the posted-folio basis; complete future-stay settlement policy remains open. No historical payment status is corrected automatically. SQL 90 is a read-only code/trigger postcheck.

## Canonical room readiness

SQL 91 changes three existing read functions. For Savannah, future reservations stop holding the sellable-now view before arrival, open cleaning jobs override stale Clean status, active overdue checked-in stays remain occupied until checkout, and same-day searches respect house-use/current occupancy and property-local dates. Future turnover planning, reservation overlaps, active holds, room blocks, maintenance, group blocks and unassigned room-type demand remain enforced. Explicit organization and property scope protect security-definer reads. Valid other-organization readiness behavior is retained. Existing function privileges and return schemas are preserved.

The repair does not complete tasks, inspect rooms, check out stays, or edit room/reservation rows. SQL 92 verifies installed code only. Both installers refuse unexpected existing definitions. Do not use a blanket database push: older migrations may contain unrelated historical changes.

## Evidence

- Full offline suite: 3,890 passes, zero failures, 155 skipped.
- Original 3,667 unique named passes and prior-batch 3,821 unique named passes retained. Assertion totals include duplicate names.
- TypeScript and production build/server smoke passed.
- Reservation/folio trigger: 25 isolated checks, including reproductions, aggregation, scopes, invalid amounts, preserved permissions and code-only installation.
- Room readiness: 47 isolated checks, including three original defect reproductions, all three read models, overdue aliases, job lifecycle, property-clock boundary, group/hold/maintenance exclusions, unchanged room rows, public return contracts, private permissions, read-only postcheck and unknown-definition refusal.

## Queue records advanced

- **NEO-BKL-D01**: Pre-arrival deposits below the quote remain partial even when an uncharged folio has zero balance; all active linked folios count. Deposit gate rejects missing/nonfinite money. SQL 89 has 25 isolated checks; no historical label backfill.
- **NEO-BKL-D02**: Reservation detail distinguishes booking balance, selected folio balance and all linked balances; active folio selection and explicit loading/error states prevent silently choosing old void/history. Other balance surfaces remain open.
- **NEO-BKL-D03**: Linked-folio aggregation, currency refusal, property-scoped cache and guarded future payment-label trigger are tested. Historical inconsistencies and full reservation-to-GL acceptance remain open.
- **NEO-BKL-J03**: Deposit capture uses the actual reservation property clock and finite positive amount; linked balances and pre-arrival status are tested. No historical financial repair or full deposit-to-folio/GL certification performed.
- **NEO-BKL-R06**: Reservation/availability caches include organization; explicit query organization filters and room-read RPC property scope tested. Savannah read-model changes retain valid protected other-organization behavior; full reciprocal role isolation remains open.
- **NEO-BKL-D07**: Availability inputs require real calendar dates, positive intervals and whole valid party counts; canonical current-day room readiness is shared by search. Durable guest confirmation and inventory hold acceptance remain open.
- **NEO-BKL-D04**: Active checked-in/in-house reservations, including overdue and underscore aliases, keep the Savannah read model occupied despite stale raw Vacant. No automatic checkout or room-row change; complete stay workflow remains open.
- **NEO-BKL-D05**: Room search now honors canonical open cleaning jobs/current occupancy and property-local dates, preserving future turnover and group/unassigned inventory deductions. Guarded SQL 91 passed isolated read-model tests.
- **NEO-BKL-E01**: A future reservation no longer holds Savannah sellable-now before its arrival; open housekeeping jobs cannot hide behind cached Clean. Dated booking overlaps and maintenance/hold exclusions remain enforced.
- **NEO-BKL-E04**: Canonical current-day availability refuses awaiting inspection/rework/failed inspection and open cleaning jobs. No job completion or supervisor release is invented; actual inspection workflow acceptance remains open.
- **NEO-BKL-E03**: Three room read models now agree on current job/occupancy/readiness, with 47 isolated PostgreSQL checks. Actual checkout-clean-inspect transitions and role attribution remain open.

No operational database connection was used for these isolated SQL checks. App changes remain local and undeployed. Physical printer output and full workflow acceptance remain separate.
