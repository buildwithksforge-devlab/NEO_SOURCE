CREATE OR REPLACE FUNCTION public.neo_delivery_record_cash_collection(
  _order uuid,
  _amount numeric,
  _reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _d public.delivery_orders;
  _existing public.rider_cash_collections;
  _org uuid := public.current_org_id();
BEGIN
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Enter the amount of cash collected';
  END IF;

  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order FOR UPDATE;
  IF _d.id IS NULL OR _d.organization_id <> _org THEN
    RAISE EXCEPTION 'Delivery order not found';
  END IF;
  IF NOT public.in_my_scope(_d.branch_id) THEN
    RAISE EXCEPTION 'This delivery belongs to another property';
  END IF;
  IF NOT (public.has_permission('delivery','cash.manage') OR public.has_permission('delivery','orders.manage')) THEN
    RAISE EXCEPTION 'Not permitted to record delivery cash';
  END IF;
  IF _d.order_status <> 'delivered' THEN
    RAISE EXCEPTION 'Cash can only be recorded against a delivered order';
  END IF;
  IF coalesce(_d.payment_method,'') <> 'cash' THEN
    RAISE EXCEPTION 'This order was not a cash-on-delivery order';
  END IF;
  IF _d.payment_status IN ('paid','settled','completed') THEN
    RAISE EXCEPTION 'This order is already settled';
  END IF;
  IF _d.rider_id IS NULL THEN
    RAISE EXCEPTION 'This delivery has no rider to hold the cash';
  END IF;

  SELECT * INTO _existing FROM public.rider_cash_collections WHERE delivery_order_id = _order;
  IF _existing.id IS NOT NULL THEN
    RAISE EXCEPTION 'Cash has already been recorded for this delivery';
  END IF;

  IF _amount <> _d.grand_total AND nullif(btrim(coalesce(_reason,'')),'') IS NULL THEN
    RAISE EXCEPTION 'Give a reason when the cash collected differs from the order total';
  END IF;

  INSERT INTO public.rider_cash_collections
    (organization_id, branch_id, delivery_order_id, rider_id, expected_amount, collected_amount,
     currency, variance_reason, created_by)
  VALUES (_d.organization_id, _d.branch_id, _order, _d.rider_id, _d.grand_total, _amount,
     coalesce(_d.currency,'KES'), nullif(btrim(coalesce(_reason,'')),''), auth.uid());

  UPDATE public.delivery_orders
     SET payment_status = CASE WHEN _amount >= grand_total THEN 'paid' ELSE payment_status END,
         updated_at = now()
   WHERE id = _order;

  IF _amount >= _d.grand_total AND _d.pos_order_id IS NOT NULL THEN
    UPDATE public.pos_orders SET payment_status = 'paid', updated_at = now()
     WHERE id = _d.pos_order_id AND coalesce(payment_status,'unpaid') <> 'paid';
  END IF;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_d.organization_id, auth.uid(), '', 'delivery.cash.recorded', 'delivery', _order::text,
    jsonb_build_object('amount', _amount, 'expected', _d.grand_total, 'reason', _reason));

  RETURN jsonb_build_object('settled', _amount >= _d.grand_total, 'amount', _amount);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_delivery_record_cash_collection(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_record_cash_collection(uuid, numeric, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_folio_line_amount_invariant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF abs(coalesce(NEW.gross_amount,0) - coalesce(NEW.discount_amount,0)
       + coalesce(NEW.tax_amount,0) + coalesce(NEW.service_charge_amount,0)
       - coalesce(NEW.net_amount,0)) > 0.01 THEN
    RAISE EXCEPTION 'Folio line total does not agree with its amount, discount, tax and service charge';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_folio_line_amount_invariant_trg ON public.folio_lines;
CREATE TRIGGER neo_folio_line_amount_invariant_trg
BEFORE INSERT ON public.folio_lines
FOR EACH ROW EXECUTE FUNCTION public.neo_folio_line_amount_invariant();