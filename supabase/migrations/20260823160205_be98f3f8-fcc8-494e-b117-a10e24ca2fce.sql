-- Laundry: number the order, keep item and order money correct from the
-- price lines, and let laundry staff complete an order so the guest charge
-- reaches the room folio through the system posting path.

CREATE OR REPLACE FUNCTION public.laundry_number_order()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.laundry_number IS NULL OR NEW.laundry_number = '' THEN
    NEW.laundry_number := public.next_document_number('laundry');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_laundry_number_order ON public.guest_laundry_orders;
CREATE TRIGGER trg_laundry_number_order
BEFORE INSERT ON public.guest_laundry_orders
FOR EACH ROW EXECUTE FUNCTION public.laundry_number_order();

CREATE OR REPLACE FUNCTION public.laundry_item_amounts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _qty numeric;
BEGIN
  _qty := COALESCE(NEW.counted_quantity, NEW.quantity, 0);
  NEW.line_total := round(_qty * COALESCE(NEW.unit_price, 0), 2);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_laundry_item_amounts ON public.guest_laundry_items;
CREATE TRIGGER trg_laundry_item_amounts
BEFORE INSERT OR UPDATE ON public.guest_laundry_items
FOR EACH ROW EXECUTE FUNCTION public.laundry_item_amounts();

CREATE OR REPLACE FUNCTION public.laundry_rollup_order()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _order uuid := COALESCE(NEW.order_id, OLD.order_id);
        _sub numeric := 0; _tax numeric := 0; _express boolean;
BEGIN
  SELECT COALESCE(sum(line_total), 0),
         COALESCE(sum(round(line_total * COALESCE(tax_rate, 0) / 100.0, 2)), 0)
    INTO _sub, _tax
    FROM public.guest_laundry_items WHERE order_id = _order;

  SELECT express INTO _express FROM public.guest_laundry_orders WHERE id = _order;
  IF COALESCE(_express, false) THEN
    _sub := round(_sub * 1.5, 2);   -- express surcharge
  END IF;

  UPDATE public.guest_laundry_orders
     SET subtotal = _sub, tax_amount = _tax, total = _sub + _tax, updated_at = now()
   WHERE id = _order AND posting_status IS DISTINCT FROM 'posted';
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_laundry_rollup_order ON public.guest_laundry_items;
CREATE TRIGGER trg_laundry_rollup_order
AFTER INSERT OR UPDATE OR DELETE ON public.guest_laundry_items
FOR EACH ROW EXECUTE FUNCTION public.laundry_rollup_order();

-- Post the guest charge with system authority (the amount is derived from the
-- counted items, never typed by the poster), so laundry staff can close an
-- order without holding manual folio-posting rights.
CREATE OR REPLACE FUNCTION public.laundry_post_charge(_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); v_order record; v_folio uuid; v_line uuid; v_key text;
BEGIN
  IF NOT (has_permission('laundry','edit') OR has_permission('laundry','approve')
          OR has_permission('laundry','complete') OR has_permission('laundry','deliver')
          OR has_permission('pms','folios.post_charge') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to post laundry charges';
  END IF;

  SELECT * INTO v_order FROM guest_laundry_orders WHERE id=_order AND organization_id=v_org FOR UPDATE;
  IF v_order IS NULL THEN RAISE EXCEPTION 'Unknown laundry order'; END IF;
  IF v_order.posting_status = 'posted' THEN
    RETURN jsonb_build_object('ok', true, 'already_posted', true, 'folio_line_id', v_order.folio_line_id);
  END IF;
  IF COALESCE(v_order.total, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_chargeable_items',
      'detail', 'Count the laundry items and price them before posting the charge.');
  END IF;

  v_folio := v_order.folio_id;
  IF v_folio IS NULL AND v_order.reservation_id IS NOT NULL THEN
    SELECT id INTO v_folio FROM folios
      WHERE organization_id=v_org AND reservation_id=v_order.reservation_id AND status='open'
      ORDER BY created_at LIMIT 1;
  END IF;
  IF v_folio IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_folio',
      'detail', 'No open guest folio for this laundry order.');
  END IF;

  v_key := 'laundry:' || _order::text;
  v_line := public.folio_post_charge(
    v_folio, 'laundry', 'Guest laundry ' || COALESCE(v_order.laundry_number,''),
    1, COALESCE(v_order.total,0) - COALESCE(v_order.tax_amount,0), COALESCE(v_order.tax_amount,0),
    0, 0, 'laundry', _order, 'laundry', v_key, NULL);

  UPDATE guest_laundry_orders
     SET posting_status='posted', folio_id=v_folio, folio_line_id=v_line, posted_at=now()
   WHERE id=_order;
  RETURN jsonb_build_object('ok', true, 'folio_line_id', v_line);
END $$;

REVOKE ALL ON FUNCTION public.laundry_number_order() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.laundry_item_amounts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.laundry_rollup_order() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.laundry_post_charge(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.laundry_post_charge(uuid) TO authenticated;