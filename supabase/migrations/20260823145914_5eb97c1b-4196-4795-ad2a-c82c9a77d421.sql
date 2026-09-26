-- UAT Scenario 2 defects:
-- (1) Bill totals were only ever computed in the browser and written back by the
--     client, so any order row could be PATCHed with an arbitrary grand_total.
--     Totals are now derived in the database from the live order lines.
-- (2) Marking an item collected/served demanded the kitchen 'item.prepare'
--     permission, so the waiter who owns service could not close the loop.

CREATE OR REPLACE FUNCTION public.pos_recalc_order_totals(_order uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE _sub numeric(14,2); _tax numeric(14,2); _disc numeric(14,2);
BEGIN
  SELECT COALESCE(sum(line_total),0), COALESCE(sum(tax_amount),0)
    INTO _sub, _tax
  FROM public.pos_order_items
  WHERE order_id = _order AND COALESCE(status,'draft') NOT IN ('cancelled','voided');

  SELECT COALESCE(discount_total,0) INTO _disc FROM public.pos_orders WHERE id = _order;

  UPDATE public.pos_orders
     SET subtotal = _sub,
         tax_total = _tax,
         grand_total = GREATEST(0, _sub - COALESCE(_disc,0))
   WHERE id = _order
     AND (subtotal IS DISTINCT FROM _sub
       OR tax_total IS DISTINCT FROM _tax
       OR grand_total IS DISTINCT FROM GREATEST(0, _sub - COALESCE(_disc,0)));
END;
$$;

REVOKE ALL ON FUNCTION public.pos_recalc_order_totals(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_recalc_order_totals(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tg_pos_recalc_order_totals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.pos_recalc_order_totals(COALESCE(NEW.order_id, OLD.order_id));
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS pos_order_items_totals ON public.pos_order_items;
CREATE TRIGGER pos_order_items_totals
AFTER INSERT OR UPDATE OF line_total, tax_amount, status OR DELETE ON public.pos_order_items
FOR EACH ROW EXECUTE FUNCTION public.tg_pos_recalc_order_totals();

-- Client-supplied totals are ignored: the order row always reflects its lines.
CREATE OR REPLACE FUNCTION public.tg_pos_order_totals_authoritative()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE _sub numeric(14,2); _tax numeric(14,2);
BEGIN
  SELECT COALESCE(sum(line_total),0), COALESCE(sum(tax_amount),0)
    INTO _sub, _tax
  FROM public.pos_order_items
  WHERE order_id = NEW.id AND COALESCE(status,'draft') NOT IN ('cancelled','voided');

  IF EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = NEW.id) THEN
    NEW.subtotal := _sub;
    NEW.tax_total := _tax;
    NEW.grand_total := GREATEST(0, _sub - COALESCE(NEW.discount_total,0));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pos_orders_totals_authoritative ON public.pos_orders;
CREATE TRIGGER pos_orders_totals_authoritative
BEFORE UPDATE ON public.pos_orders
FOR EACH ROW EXECUTE FUNCTION public.tg_pos_order_totals_authoritative();