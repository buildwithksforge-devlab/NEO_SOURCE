-- Short-closing: when a supplier will not deliver the balance (e.g. rejected
-- goods that are not replaced), an approver must be able to close the order so
-- it stops sitting in "partially-received" forever.
CREATE OR REPLACE FUNCTION public.neo_procurement_order_close(_order uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _p record;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF nullif(btrim(coalesce(_reason,'')),'') IS NULL THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO _p FROM public.purchase_orders WHERE id=_order AND organization_id=_org FOR UPDATE;
  IF _p IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_p.branch_id) THEN
    RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501';
  END IF;
  IF NOT (public.has_permission('procurement','lpos.approve') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;
  IF _p.status IN ('closed','cancelled','void') THEN
    RAISE EXCEPTION 'order_already_closed' USING ERRCODE='22023';
  END IF;

  UPDATE public.purchase_order_lines
     SET cancelled_quantity = GREATEST(quantity - COALESCE(accepted_quantity,0), 0),
         close_reason = _reason,
         updated_at = now()
   WHERE order_id = _order
     AND COALESCE(accepted_quantity,0) + COALESCE(cancelled_quantity,0) < quantity;

  UPDATE public.purchase_orders
     SET status='closed', closed_at=now(), closed_by=auth.uid(), close_reason=_reason, updated_at=now()
   WHERE id=_order;

  INSERT INTO public.audit_logs (organization_id, branch_id, module, action, record_id, user_id, reason, new_value)
  VALUES (_org, _p.branch_id, 'procurement', 'order.short_closed', _order::text, auth.uid(), _reason,
          jsonb_build_object('status','closed'));

  RETURN jsonb_build_object('ok', true, 'order_id', _order, 'status', 'closed');
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_procurement_order_close(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_procurement_order_close(uuid, text) TO authenticated;