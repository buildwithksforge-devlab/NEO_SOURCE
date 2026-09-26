-- UAT Scenario 2 defect: an order confirmed before dispatch never moved to
-- 'sent', because the status advance only recognised open/new/draft-sent.
-- The rollup trigger then refused to progress it, so a fully served order
-- still displayed as 'confirmed' and never reached settlement.
CREATE OR REPLACE FUNCTION public.pos_rollup_order_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _total int; _ready int; _served int; _order public.pos_orders; _target text;
BEGIN
  SELECT * INTO _order FROM public.pos_orders WHERE id = NEW.order_id;
  IF _order.id IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) FILTER (WHERE status NOT IN ('cancelled','voided','draft')),
         count(*) FILTER (WHERE status IN ('ready','served')),
         count(*) FILTER (WHERE status = 'served')
    INTO _total, _ready, _served
  FROM public.pos_order_items WHERE order_id = NEW.order_id;
  IF _total = 0 THEN RETURN NEW; END IF;
  _target := CASE
    WHEN _served = _total THEN 'served'
    WHEN _served > 0 THEN 'partially-served'
    WHEN _ready = _total THEN 'ready'
    WHEN _ready > 0 THEN 'partially-ready'
    ELSE NULL END;
  IF _target IS NOT NULL AND _target <> _order.status
     AND _order.status IN ('confirmed','sent','accepted','in-preparation','partially-ready','ready','partially-served') THEN
    UPDATE public.pos_orders SET status = _target,
      served_at = CASE WHEN _target = 'served' THEN now() ELSE served_at END
    WHERE id = _order.id;
  END IF;
  RETURN NEW;
END;
$function$;