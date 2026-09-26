CREATE OR REPLACE FUNCTION public.neo_po_sync_receipt_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_order uuid := COALESCE(NEW.order_id, OLD.order_id);
  v_status text;
  v_any numeric;
  v_outstanding numeric;
BEGIN
  IF v_order IS NULL THEN RETURN NULL; END IF;

  SELECT status INTO v_status FROM public.purchase_orders WHERE id = v_order;
  IF v_status IS NULL
     OR v_status IN ('closed','cancelled','voided','rejected','draft','pending_approval','pending-approval',
                     'fully-invoiced','invoiced','partially-invoiced','paid','partially-paid') THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(COALESCE(pl.accepted_quantity,0)),0),
         COALESCE(sum(GREATEST(COALESCE(pl.quantity,0)
                               - COALESCE(pl.accepted_quantity,0)
                               - COALESCE(pl.cancelled_quantity,0), 0)),0)
    INTO v_any, v_outstanding
    FROM public.purchase_order_lines pl
   WHERE pl.order_id = v_order;

  IF v_any > 0 AND v_outstanding <= 0.0001 THEN
    UPDATE public.purchase_orders SET status='received', updated_at=now()
     WHERE id=v_order AND status <> 'received';
  ELSIF v_any > 0 THEN
    UPDATE public.purchase_orders SET status='partially-received', updated_at=now()
     WHERE id=v_order AND status <> 'partially-received';
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS po_lines_sync_receipt_status ON public.purchase_order_lines;
CREATE TRIGGER po_lines_sync_receipt_status
AFTER INSERT OR UPDATE OF accepted_quantity, received_quantity, cancelled_quantity, quantity
ON public.purchase_order_lines
FOR EACH ROW EXECUTE FUNCTION public.neo_po_sync_receipt_status();

REVOKE ALL ON FUNCTION public.neo_po_sync_receipt_status() FROM PUBLIC, anon;