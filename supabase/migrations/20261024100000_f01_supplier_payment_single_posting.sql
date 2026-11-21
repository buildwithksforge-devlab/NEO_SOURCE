-- NEØ F01: supplier-payment single posting ownership.
--
-- DEF-MVLF4298
-- The supplier-payment settlement RPC already posts the AP/payment journal.
-- The legacy automatic trigger independently posts the same payment.
--
-- Remove only the redundant supplier-payment trigger.
-- Preserve all other automatic finance posting triggers.
--
-- This migration does not modify historical payments or journals.

DROP TRIGGER IF EXISTS supplier_payments_autopost_txn
ON public.supplier_payments;