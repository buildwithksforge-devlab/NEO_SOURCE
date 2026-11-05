-- NEO P1.5B - GUEST LAUNDRY SYNCHRONIZATION CONSOLIDATION
-- LOCAL DRAFT - DO NOT DEPLOY
--
-- Preserve the canonical September 24 guest-batch synchronization.
-- Remove the redundant October 25 synchronization trigger.
--
-- No historical guest laundry orders or linen batches modified.

DROP TRIGGER IF EXISTS trg_laundry_batch_order_sync
ON public.laundry_batches;

-- Do not drop neo_laundry_batch_order_sync() here.
-- Retain its definition for dependency and migration compatibility review.
--
-- Canonical trigger retained:
-- neo_sync_guest_laundry_from_batch_trg
--
-- Canonical function retained:
-- neo_sync_guest_laundry_from_batch()
