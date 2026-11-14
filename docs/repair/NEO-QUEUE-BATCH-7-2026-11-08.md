# NEØ guest laundry synchronization — batch 7

Original queue: NEO-BKL-H01 and H03; H02 remains a separate delivery/accounting gate.

Two defects were reproduced in isolated PostgreSQL-compatible fixtures: an unset transition flag bypassed the direct-transition condition, and the batch trigger left its internal flag enabled within the caller's transaction. Older batches could also overwrite the guest order's newer processing state.

The code-only SQL 87 candidate defaults the flag to off, restores its prior value on success/error, selects the latest matching guest batch deterministically, ignores non-guest batches, and preserves held/disputed/cancelled or final guest orders. Every existing processing-stage mapping remains: completed processing means ready for delivery, never proof of physical guest handover or Finance posting.

Installation requires exact fingerprints of both reviewed source definitions and enabled lifecycle triggers. A different installed version is refused for inspection. It changes the two functions only; no existing batch/order is advanced and no charge or historical correction is performed. SQL 88 is a read-only installation check for the later deployment stage.

The isolated final suite passed **32 checks** covering canonical stage mappings, stale/tied batches, replay timestamps, transaction flag restoration, controlled failures and rollback, cross-property/workspace isolation, protected statuses, retained handover/Finance definitions, guarded installation and positive/negative postchecks. The original handover and Finance trigger definitions remain unchanged in the fixture.

No operational connection was used. The application-wide regression run belongs to batch 6 source changes; SQL 87 is separately verified in this isolated database suite. Broader laundry collection, delivery, folio posting and actual operational installation remain acceptance gates.


The staff client now requires the existing batch RPC to return ok=true and the requested status before reporting success. Successful changes invalidate the current workspace guest-status cache alongside staff views. Six dedicated client checks passed. The fresh full application regression passed 3,831 tests with zero failures and 155 skipped; fresh final TypeScript and production build/server smoke also passed. See NEO-BATCHES-6-7-VALIDATION-2026-11-08.json.


