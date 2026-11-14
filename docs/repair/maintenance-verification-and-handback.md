# Maintenance verification and room handback — local repair

This repair targets MT03/MT04 and the guest-stay maintenance handoff. It does not certify the entire maintenance department or mark live UAT outcomes passed.

## Source behavior

- The maintenance board uses `neo_maint_job_advance` for status-only transitions, matching the technician path. The client no longer stamps verification when a job merely enters review.
- Verification closure collects a note. The database enforces the normal transition order, named technician, independent verifier, completed repair and authorised property. Direct updates cannot bypass these lifecycle checks or forge completion/verification timestamps.
- Status history is recorded once when the existing `wo_track_status` trigger is enabled. The RPC's note is retained in that authoritative event, and the caller's prior transaction-note setting is restored.
- `wo_set_block` requires independently verified closure before removing an active job hold. It checks the room belongs to the same property and serialises hold changes on the room.
- Removing one hold preserves other maintenance holds. The last verified hold hands the room back dirty/operational through the existing room-state routine. Occupancy is not changed. The browser distinguishes partial hold removal from actual room handback and refreshes PMS, operations and technician views.
- Repeating a successful release does not dirty an already cleaned room or create another audit. An audit failure rolls the attempted room/hold change back.
- A job without its own hold is labelled "No job hold" instead of claiming the room is available for sale.

## SQL Editor run order

Confirm the project is `zlrrmrcqlerafptkgucl`, matching the configured application. This database contains real operations.

1. Run `35_READ_ONLY_MAINTENANCE_PREFLIGHT.sql`; save deployed function definitions, trigger definitions, policies and history. Preserve a usable recovery snapshot. Check the current room-state routine, maintenance status/assignment/asset triggers and ordinary-role prerequisites.
2. Compare against the reviewed checkout. `40_APPLY_VERIFIED_MAINTENANCE.sql` refuses a different lifecycle, release or history function, or a missing/unreviewed room-state trigger. Resolve a mismatch before applying; do not remove guards or deploy older drafts blindly.
3. Submit `40_APPLY_VERIFIED_MAINTENANCE.sql` as one complete transaction. It is version `20261106093000`, with bounded lock/statement timeouts. It grants no additional staff capability and corrects no historical rows. Do not also apply the individual migration afterward.
4. Run `97_READ_ONLY_MAINTENANCE_POSTCHECK.sql` and preserve its results. Deploy the matching application revision only after database parity is confirmed.
5. Mark only an actually committed and verified version as applied using the linked-project migration-history procedure from the main SQL run order:

```powershell
npx supabase migration repair 20261106093000 --status applied --linked
```

A failed bundle cannot commit partially; use `ROLLBACK;` if SQL Editor retains an aborted transaction. Preserve preflight definitions for a separately reviewed recovery. Reverting application code does not undo operational status transitions, audits or room handbacks that have already committed.

## Controlled UAT

Use an isolated lane or an explicitly approved labelled operational test, with the real permitted/denied roles and the correct property. Record work order, room/stay, technician, verifier, history/audit IDs and server times. Never use an unrelated occupied room as a synthetic test.

1. Start with an occupied stay and a held maintenance work order. Technician accepts, diagnoses/works and completes the repair. Attempt early release at assigned, completed and awaiting-verification stages; all must remain blocked.
2. Supervisor sends it for checking. Confirm verification fields remain empty. Reject self-verification, missing note, invalid transition, cross-property access and direct timestamp/status forgery.
3. Independently verify and close with a real check note. Reload the board and technician view. Confirm one history event per transition, correct actor, retained note and final verification timestamps.
4. Release the hold. Confirm saved audit, dirty housekeeping state, operational maintenance state, unchanged active occupancy and unsellability until normal stay/turnover rules permit otherwise. Continue the normal housekeeping/inspection path; recheck the original passed neighbors.
5. In isolation, add two genuine holds against the same room. Verify each repair separately. Remove one hold: room stays blocked and UI warns. Remove the final verified hold: normal dirty handback occurs. Do not allow one job's release to clear another job's safety hold.
6. In isolation, fail audit persistence and verify no partial room/hold change. Retry after recovery. Repeat a successful release after cleaning and confirm it changes no room state and creates no duplicate audit.
7. Test a vacant-room turnover control, maintenance-blocked control, role/scope denial, ordinary assignment, preventive-work neighbors and existing asset integration on the same deployed revision.

The isolated fixture executes real lifecycle, room-state, history and room-status functions. Authentication/permission context and audit transport use fixture adapters; full deployed role policy, notification routing, stock/parts, asset service history and the physical hotel remain separate evidence requirements.

## Findings retained for the next flow

- Guest request Start currently uses a direct update without reading the saved row back (`useUpdateGuestRequestStatus`), so a zero-row update can report success. Its owning request lifecycle needs an atomic result/permission review.
- The asset service trigger currently marks an asset serviced/in-service at technician completion as well as closure. Independent verification and multiple outstanding asset repairs need their own focused repair and UAT before the asset workflow can be certified.
- Work-order intake derives retry identity from content, so genuinely separate identical reports need a fresh-request/retry repair. Its security-definer creation function validates property membership in the organisation but also needs explicit caller property-scope enforcement before idempotent replay. Both remain open in the intake boundary.

These findings remain open; they are not silently counted as repaired by this room-handback batch.
