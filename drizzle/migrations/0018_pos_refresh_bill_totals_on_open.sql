CREATE OR REPLACE FUNCTION neo_private.pos_refresh_bill_totals(_order uuid, _actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE _b public.pos_orders; _a public.pos_orders; _changed boolean := false;
BEGIN
  SELECT * INTO _b FROM public.pos_orders WHERE id = _order FOR UPDATE;
  IF _b.id IS NULL THEN RETURN jsonb_build_object('refreshed', false, 'reason', 'not_found'); END IF;
  BEGIN
    -- The authoritative totals trigger re-derives subtotal, tax, service charge and
    -- grand total from the live items on any update. If nothing moves, undo the write.
    UPDATE public.pos_orders SET updated_at = now() WHERE id = _order RETURNING * INTO _a;
    IF (_a.subtotal, _a.tax_total, _a.service_charge_total, _a.discount_total, _a.grand_total)
       IS NOT DISTINCT FROM (_b.subtotal, _b.tax_total, _b.service_charge_total, _b.discount_total, _b.grand_total) THEN
      RAISE EXCEPTION 'totals unchanged' USING ERRCODE = 'NEOUN';
    END IF;
    _changed := true;
  EXCEPTION WHEN SQLSTATE 'NEOUN' THEN _changed := false;
  END;
  IF NOT _changed THEN
    RETURN jsonb_build_object('refreshed', false, 'reason', 'unchanged', 'grand_total', _b.grand_total);
  END IF;
  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id,
                                 previous_value, new_value, reason)
  VALUES (_b.organization_id, _b.branch_id, _actor, '', 'restaurant.order.totals_refreshed', 'restaurant', _order::text,
          jsonb_build_object('subtotal', _b.subtotal, 'tax_total', _b.tax_total, 'service_charge_total', _b.service_charge_total,
                             'discount_total', _b.discount_total, 'grand_total', _b.grand_total),
          jsonb_build_object('subtotal', _a.subtotal, 'tax_total', _a.tax_total, 'service_charge_total', _a.service_charge_total,
                             'discount_total', _a.discount_total, 'grand_total', _a.grand_total),
          'Bill reopened: stored total recalculated from its items');
  RETURN jsonb_build_object('refreshed', true, 'previous_total', _b.grand_total, 'grand_total', _a.grand_total);
END $$;
REVOKE EXECUTE ON FUNCTION neo_private.pos_refresh_bill_totals(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.neo_pos_refresh_bill_totals(_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _o public.pos_orders; _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO _o FROM public.pos_orders WHERE id = _order AND organization_id = public.current_org_id();
  IF _o.id IS NULL THEN RETURN jsonb_build_object('refreshed', false, 'reason', 'not_found'); END IF;
  -- Same rule as editing the bill: take-orders permission and the bill in the caller's scope.
  IF NOT (public.has_permission('pos', 'orders.create')
          AND (public.in_my_scope(_o.organization_id, _o.branch_id, _o.department_id, _o.station_id, _o.waiter_id, _o.created_by)
               OR public.is_shared_with_me('pos_order', _o.id))) THEN
    RETURN jsonb_build_object('refreshed', false, 'reason', 'not_permitted', 'grand_total', _o.grand_total);
  END IF;
  -- Finished, paid or mid-M-Pesa bills keep the total that was charged.
  IF _o.status IN ('paid','charged-to-room','credit','closed','completed','settled','voided','void','cancelled','refunded')
     OR coalesce(_o.payment_status, 'unpaid') IN ('paid','settled','complimentary','transferred','charged_to_room')
     OR coalesce(_o.rounding_adjustment, 0) <> 0 THEN
    RETURN jsonb_build_object('refreshed', false, 'reason', 'locked', 'grand_total', _o.grand_total);
  END IF;
  RETURN neo_private.pos_refresh_bill_totals(_order, _uid);
END $$;
REVOKE EXECUTE ON FUNCTION public.neo_pos_refresh_bill_totals(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_refresh_bill_totals(uuid) TO authenticated;