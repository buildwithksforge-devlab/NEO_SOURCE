# Workflow code review — 14 November 2026

This answers whether the implementation contains logic defects, not whether a live test has run. The earlier statement that the workflows exist was not a code-correctness finding.

## Confirmed defects and source changes

1. POS item creation wrote the item, modifiers and recalculation as separate browser requests. A modifier or recalculation failure could leave a saved line after reporting failure. Changed the existing item insert to carry selected option IDs; new BEFORE/AFTER database triggers validate the catalogue, required/minimum/maximum choices, canonical extra charges and save modifier rows in the item transaction before routing/totals triggers. No new endpoint/RPC. New migration 20261114011000_atomic_pos_selection_modifiers.sql must be installed before this frontend is released.
2. Draft deletion did not check pending/recorded collections; it also did not check the order ID or verify that a row was removed. Added scoped deletion/result verification and a database line/modifier guard with parent bill locking. The guard covers POS payments, routed cash requests and M-Pesa attempts; service/station updates remain allowed. Migration 20261114010000_protect_collected_pos_bill_lines.sql is not installed yet.
3. Check-in/check-out accepted any error-free transport response as success. They now require saved stay/folio identifiers and reject explicit business failure.
4. Kitchen dispatch converted missing results to zero counters and could report success. It now verifies the returned order identity and complete nonnegative routing counters.
5. Room-charge UI accepted a missing or failed result as success. It now requires the existing RPC's saved folio-line UUID before reporting success.
6. The manual-confirm button checked orders.approve while the backend requires pos/payments/manual-confirm. UI now checks the exact backend permission.
7. Check-in reconciliation cache lacked organization/user identity. It is now partitioned by both and waits for authentication.
8. Item choices could be submitted while options were loading/failed, inactive groups were included and min/max selection limits were not enforced. Corrected those client conditions; failed item creation keeps the selection dialog open.

## Still open — actual code issues, not requests for user testing

- The inventoried workspace-specific backend conditions were replaced by 23 individually reviewed explicit definitions, guarded against the exact installed source fingerprints. The user returned all 23 definition matches true for `shared-workspace-workflows-v1`. Organization/property/role boundaries remain in the shared implementation; legitimate per-property configuration remains separate. Historical migrations retain their original definitions for migration history.
- Item creation still needs stable per-selection intent identity for retry after a lost successful HTTP response. Atomic modifiers prevent partial writes but do not alone prove the outcome of a transport timeout.
- The original KES51 paid draft has no current lines; historical snapshot recovery remains separate from these forward code guards.

## State

The user confirmed `pos-collected-bill-atomic-selections-v1`: both routines and the selection column installed, with all four triggers enabled. Isolated PostgreSQL checks passed for required choices, atomic modifier persistence, canonical prices/tax, pending-payment item/modifier protection and allowed service transitions. No real payment was collected by those checks. The matching app release is being verified; deployment is recorded separately. Compilation and isolated checks do not certify every operational workflow. The lost-response retry identity and KES51 recovery above remain open.
