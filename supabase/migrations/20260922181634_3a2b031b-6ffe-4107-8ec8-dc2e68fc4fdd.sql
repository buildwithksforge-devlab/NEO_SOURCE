CREATE OR REPLACE FUNCTION public.neo_delivery_sync_payment_from_pos()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
     AND NEW.payment_status IN ('paid','partial','refunded') THEN
    UPDATE public.delivery_orders d
       SET payment_status = CASE WHEN NEW.payment_status = 'partial' THEN 'partially-paid'
                                 ELSE NEW.payment_status END
     WHERE d.pos_order_id = NEW.id
       AND d.payment_status IS DISTINCT FROM (CASE WHEN NEW.payment_status = 'partial' THEN 'partially-paid'
                                                   ELSE NEW.payment_status END);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS neo_delivery_sync_payment_from_pos_trg ON public.pos_orders;
CREATE TRIGGER neo_delivery_sync_payment_from_pos_trg
AFTER UPDATE OF payment_status ON public.pos_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_delivery_sync_payment_from_pos();

REVOKE ALL ON FUNCTION public.neo_delivery_sync_payment_from_pos() FROM PUBLIC, anon, authenticated;

UPDATE public.delivery_orders
   SET payment_status = 'paid'
 WHERE id = 'a52b7eca-1b78-4ae2-8e34-72467d854648'
   AND payment_status <> 'paid';