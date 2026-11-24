CREATE OR REPLACE FUNCTION public.neo_laundry_order_advance(_order uuid, _status text, _note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _row public.guest_laundry_orders%ROWTYPE;
  _posting jsonb;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF (
    public.has_permission('laundry','orders','edit') OR
    public.has_permission('laundry','orders','approve') OR
    public.is_org_admin()
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Not permitted to update guest laundry' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _row
    FROM public.guest_laundry_orders
   WHERE id=_order AND organization_id=_org
   FOR UPDATE;
  IF _row.id IS NULL THEN RAISE EXCEPTION 'Laundry order not found'; END IF;


  -- neo_laundry_scope_transition_guard_v1
  IF auth.uid() IS NULL
     OR public.neo_branch_in_scope(_row.branch_id) IS NOT TRUE
  THEN
    RAISE EXCEPTION 'Laundry order is outside your branch scope'
      USING ERRCODE = '42501';
  END IF;

  IF _status IS NULL OR (
    _status IS DISTINCT FROM _row.status
    AND NOT COALESCE(
      CASE _row.status
        WHEN 'requested' THEN
          _status IN ('collected', 'on-hold', 'cancelled')
        WHEN 'awaiting-collection' THEN
          _status IN ('collected', 'on-hold', 'cancelled')
        WHEN 'collected' THEN
          _status IN ('on-hold', 'disputed', 'cancelled')
        WHEN 'ready-for-delivery' THEN
          _status IN ('delivered', 'on-hold', 'disputed')
        WHEN 'delivered' THEN
          _status IN ('completed', 'disputed')
        WHEN 'on-hold' THEN
          _status IN ('collected', 'disputed', 'cancelled')
        WHEN 'disputed' THEN
          _status IN ('on-hold', 'ready-for-delivery', 'cancelled')
        ELSE false
      END,
      false
    )
  ) THEN
    RAISE EXCEPTION 'Laundry transition from % to % is not permitted',
      _row.status, _status
      USING ERRCODE = '22023';
  END IF;

  IF _status = _row.status THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'status',_row.status,
      'posting_status',_row.posting_status);
  END IF;

  IF _status = 'delivered' THEN
    UPDATE public.guest_laundry_orders
       SET status='delivered',
           delivered_at=COALESCE(delivered_at,now()),
           delivery_confirmed_by=COALESCE(delivery_confirmed_by,auth.uid()),
           discrepancy_notes=concat_ws(' ',NULLIF(discrepancy_notes,''),NULLIF(btrim(_note),'')),
           updated_at=now()
     WHERE id=_order;

    -- Delivery and accounting are separate facts.  Retry the canonical Finance
    -- posting and leave the order visibly blocked when the guest/folio/payment
    -- context is not sufficient rather than pretending it was billed.
    _posting := public.neo_laundry_retry_posting(_order);

    SELECT * INTO _row FROM public.guest_laundry_orders WHERE id=_order;
    PERFORM public.log_audit_event(
      _org,'laundry.order.delivered','laundry',_order::text,
      jsonb_build_object('status','ready-for-delivery'),
      jsonb_build_object('status',_row.status,'delivered_at',_row.delivered_at,
                         'posting_status',_row.posting_status,'posting',_posting),
      COALESCE(NULLIF(btrim(_note),''),'Guest laundry handed back'));

    RETURN jsonb_build_object('ok',true,'status',_row.status,
      'delivered_at',_row.delivered_at,'posting_status',_row.posting_status,
      'posting',_posting);
  END IF;

  IF _status = 'completed' THEN
    UPDATE public.guest_laundry_orders
       SET status='completed',updated_at=now()
     WHERE id=_order;
    RETURN jsonb_build_object('ok',true,'status','completed');
  END IF;

  UPDATE public.guest_laundry_orders
     SET status=_status,
         collected_at=CASE WHEN _status='collected' AND collected_at IS NULL THEN now() ELSE collected_at END,
         discrepancy_notes=CASE WHEN _status IN ('on-hold','disputed')
           THEN concat_ws(' ',NULLIF(discrepancy_notes,''),NULLIF(btrim(_note),''))
           ELSE discrepancy_notes END,
         updated_at=now()
   WHERE id=_order;

  RETURN jsonb_build_object('ok',true,'status',_status);
END;
$function$
