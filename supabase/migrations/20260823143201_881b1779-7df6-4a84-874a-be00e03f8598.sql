-- Folio money movements now keep the reservation's payment status truthful.
CREATE OR REPLACE FUNCTION public.tg_folio_sync_reservation_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.reservation_id IS NOT NULL THEN
    UPDATE public.reservations r
       SET payment_status = CASE
             WHEN COALESCE(NEW.total_payments,0) <= 0 THEN 'unpaid'
             WHEN COALESCE(NEW.balance,0) <= 0 THEN 'paid'
             ELSE 'part-paid' END,
           updated_at = now()
     WHERE r.id = NEW.reservation_id
       AND r.payment_status IS DISTINCT FROM CASE
             WHEN COALESCE(NEW.total_payments,0) <= 0 THEN 'unpaid'
             WHEN COALESCE(NEW.balance,0) <= 0 THEN 'paid'
             ELSE 'part-paid' END;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS folio_sync_reservation_payment_status ON public.folios;
CREATE TRIGGER folio_sync_reservation_payment_status
AFTER UPDATE OF total_payments, balance ON public.folios
FOR EACH ROW EXECUTE FUNCTION public.tg_folio_sync_reservation_payment_status();

REVOKE ALL ON FUNCTION public.tg_folio_sync_reservation_payment_status() FROM PUBLIC, anon;

-- Backfill existing stays from their folios.
UPDATE public.reservations r
   SET payment_status = CASE
         WHEN COALESCE(f.total_payments,0) <= 0 THEN 'unpaid'
         WHEN COALESCE(f.balance,0) <= 0 THEN 'paid'
         ELSE 'part-paid' END
  FROM public.folios f
 WHERE f.reservation_id = r.id
   AND r.payment_status IS DISTINCT FROM CASE
         WHEN COALESCE(f.total_payments,0) <= 0 THEN 'unpaid'
         WHEN COALESCE(f.balance,0) <= 0 THEN 'paid'
         ELSE 'part-paid' END;