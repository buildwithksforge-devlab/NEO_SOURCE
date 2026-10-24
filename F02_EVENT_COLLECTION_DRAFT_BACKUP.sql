-- NEØ F02: prevent duplicate event collections.
-- DEF-MVIFBIVM
--
-- Event billing already creates and posts a dedicated payment journal.
-- Prevent legacy automatic mechanisms from posting the same
-- collection a second or third time.
--
-- No historical payments or journals are modified.

-- 1. Remove the legacy event-payment posting trigger.
DROP TRIGGER IF EXISTS tg_neo_event_payment_autopost
ON public.event_payments;

-- 2. Prevent the general folio-payment autopost trigger from
-- processing event receipts.
--
-- Preserve the trigger for all other payments. A trigger WHEN
-- condition filters only event-sourced payments.

DROP TRIGGER IF EXISTS payments_autopost_txn
ON public.payments;

CREATE TRIGGER payments_autopost_txn
AFTER INSERT OR UPDATE
ON public.payments
FOR EACH ROW
WHEN (NEW.source_module IS DISTINCT FROM 'events')
EXECUTE FUNCTION public.neo_autopost_txn();

-- 3. Event booking deposit updates must not create an additional
-- cash collection through the general event_deposit posting route.
--
-- Preserve event completion and cancellation posting behaviour by
-- modifying the event-booking autopost function separately.
--
-- Do not remove event_bookings_autopost_txn here.
-- Its existing behaviour requires a separate targeted correction.