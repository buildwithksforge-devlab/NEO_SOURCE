CREATE OR REPLACE FUNCTION public.neo_delivery_assign(_order uuid, _rider uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.delivery_orders; _new public.rider_profiles; _prev public.rider_profiles;
  _cand record; _found boolean := false; _reason_clean text := nullif(btrim(coalesce(_reason,'')),'');
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('delivery','dispatch.assign') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'The delivery.dispatch.assign permission is required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _o FROM public.delivery_orders
   WHERE id = _order AND organization_id = _org FOR UPDATE;
  IF _o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found'); END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION 'That order is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF _o.order_status IN ('delivered','cancelled','rejected','failed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_closed',
      'detail', 'That order is already ' || _o.order_status || '.');
  END IF;
  IF _o.rider_id = _rider THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_assigned',
      'detail', 'That rider already holds this order.');
  END IF;
  IF _o.rider_id IS NOT NULL AND _reason_clean IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required',
      'detail', 'Reassigning an order requires a written reason.');
  END IF;

  FOR _cand IN SELECT * FROM public.neo_delivery_dispatch_candidates(_order) c WHERE c.rider_id = _rider LOOP
    _found := true;
    IF _cand.eligible IS NOT TRUE THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'rider_ineligible',
        'detail', array_to_string(_cand.reasons, '; '), 'reasons', to_jsonb(_cand.reasons));
    END IF;
  END LOOP;
  IF NOT _found THEN RETURN jsonb_build_object('ok', false, 'reason', 'rider_not_found'); END IF;

  SELECT * INTO _new FROM public.rider_profiles WHERE id = _rider;
  IF _o.rider_id IS NOT NULL THEN
    SELECT * INTO _prev FROM public.rider_profiles WHERE id = _o.rider_id;
  END IF;

  UPDATE public.delivery_orders
     SET rider_id = _rider, dispatch_status = 'assigned', updated_at = now()
   WHERE id = _order;

  INSERT INTO public.delivery_order_status_history
    (organization_id, delivery_order_id, status_kind, previous_status, new_status, reason, changed_by)
  VALUES (_org, _order, 'dispatch', coalesce(_prev.display_name, 'unassigned'),
          coalesce(_new.display_name, 'rider'), _reason_clean, auth.uid());

  PERFORM public.neo_delivery_rider_notify(
    _org, _rider, 'delivery.assigned', 'Delivery assigned to you',
    _o.order_number || coalesce(' · ' || _o.contact_name, '') ||
      coalesce(' · reassigned: ' || _reason_clean, ''),
    'delivery.assign:' || _order::text || ':' || _rider::text,
    _order, _prev.id, _rider, 'high', '/rider');

  IF _prev.id IS NOT NULL THEN
    PERFORM public.neo_delivery_rider_notify(
      _org, _prev.id, 'delivery.reassigned', 'Delivery reassigned',
      _o.order_number || ' is now with ' || coalesce(_new.display_name,'another rider') ||
        coalesce(' — ' || _reason_clean, ''),
      'delivery.unassign:' || _order::text || ':' || _prev.id::text || ':' || _rider::text,
      _order, _prev.id, _rider, 'normal', '/rider');
  END IF;

  INSERT INTO public.audit_logs
    (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '',
    CASE WHEN _prev.id IS NULL THEN 'delivery.dispatch.assign' ELSE 'delivery.dispatch.reassign' END,
    'delivery', _order::text,
    jsonb_build_object('rider_id', _prev.id, 'rider', _prev.display_name),
    jsonb_build_object('rider_id', _rider, 'rider', _new.display_name),
    _reason_clean);

  RETURN jsonb_build_object('ok', true, 'order_id', _order, 'rider_id', _rider,
    'previous_rider_id', _prev.id, 'reassigned', _prev.id IS NOT NULL);
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_delivery_notification_audit(_branch uuid DEFAULT NULL::uuid, _limit integer DEFAULT 100)
 RETURNS TABLE(created_at timestamp with time zone, event_type text, rider_id uuid, rider_code text, rider_name text, order_id uuid, order_number text, previous_rider_name text, new_rider_name text, actor_name text, notification_id uuid, notification_status text, idempotency_key text, duplicate_suppressed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT (public.has_permission('delivery','dispatch.view')
          OR public.has_permission('delivery','riders.manage')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT e.created_at, e.event_type, e.rider_id, r.rider_code,
         coalesce(p.full_name, r.rider_code)::text,
         e.order_id, o.order_number,
         pp.full_name::text, np.full_name::text, ap.full_name::text,
         e.notification_id,
         coalesce(n.status, CASE WHEN n.read_at IS NOT NULL THEN 'read' WHEN n.id IS NOT NULL THEN 'sent' ELSE 'not-delivered' END)::text,
         e.idempotency_key, e.duplicate_suppressed
    FROM public.rider_notification_events e
    JOIN public.rider_profiles r ON r.id = e.rider_id
    LEFT JOIN public.profiles p ON p.id = r.profile_id
    LEFT JOIN public.delivery_orders o ON o.id = e.order_id
    LEFT JOIN public.rider_profiles prv ON prv.id = e.previous_rider_id
    LEFT JOIN public.profiles pp ON pp.id = prv.profile_id
    LEFT JOIN public.rider_profiles nrr ON nrr.id = e.new_rider_id
    LEFT JOIN public.profiles np ON np.id = nrr.profile_id
    LEFT JOIN public.profiles ap ON ap.id = e.actor_id
    LEFT JOIN public.notifications n ON n.id = e.notification_id
   WHERE e.organization_id = _org
     AND public.neo_branch_in_scope(e.branch_id)
     AND (_branch IS NULL OR e.branch_id = _branch)
   ORDER BY e.created_at DESC
   LIMIT greatest(coalesce(_limit, 100), 1);
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_notify(_org uuid, _rider uuid, _event text, _title text, _body text, _idem text, _order uuid DEFAULT NULL::uuid, _previous_rider uuid DEFAULT NULL::uuid, _new_rider uuid DEFAULT NULL::uuid, _priority text DEFAULT NULL::text, _link text DEFAULT '/rider'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _r public.rider_profiles; _id uuid;
BEGIN
  SELECT * INTO _r FROM public.rider_profiles WHERE id = _rider AND organization_id = _org;
  IF _r.profile_id IS NULL THEN RETURN; END IF;

  INSERT INTO public.notifications
    (organization_id, branch_id, user_id, category, title, body, link, priority,
     source_module, source_record_id, event_type, idempotency_key)
  VALUES (_org, _r.branch_id, _r.profile_id, 'operations', _title, _body,
          coalesce(_link, '/rider'), coalesce(_priority, 'normal'),
          'delivery', coalesce(_order, _rider), _event, _idem)
  ON CONFLICT DO NOTHING
  RETURNING id INTO _id;

  INSERT INTO public.rider_notification_events
    (organization_id, branch_id, rider_id, order_id, event_type, previous_rider_id, new_rider_id,
     actor_id, notification_id, idempotency_key, duplicate_suppressed)
  VALUES (_org, _r.branch_id, _rider, _order, _event, _previous_rider, _new_rider,
          auth.uid(),
          coalesce(_id, (SELECT n.id FROM public.notifications n
                          WHERE n.organization_id = _org AND n.idempotency_key = _idem LIMIT 1)),
          _idem, _id IS NULL);
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_grn_guard_over_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _ordered numeric; _already numeric;
BEGIN
  IF NEW.order_line_id IS NULL THEN RETURN NEW; END IF;

  SELECT coalesce(l.quantity, 0) - coalesce(l.cancelled_quantity, 0)
    INTO _ordered FROM public.purchase_order_lines l WHERE l.id = NEW.order_line_id;
  IF _ordered IS NULL THEN RETURN NEW; END IF;

  SELECT coalesce(sum(coalesce(g.quantity_received, 0)), 0) INTO _already
    FROM public.goods_receipt_lines g
   WHERE g.order_line_id = NEW.order_line_id
     AND g.id <> coalesce(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF _already + coalesce(NEW.quantity_received, 0) > _ordered + 0.0001 THEN
    IF nullif(btrim(coalesce(NEW.over_receipt_reason,'')),'') IS NULL THEN
      RAISE EXCEPTION 'over_receipt_refused: % ordered, % already received, % now. Record an authorised over-receipt reason to proceed.',
        _ordered, _already, coalesce(NEW.quantity_received, 0) USING ERRCODE = '23514';
    END IF;
    IF NOT (public.has_permission('procurement','receiving.override') OR public.is_org_admin()) THEN
      RAISE EXCEPTION 'over_receipt_not_authorised' USING ERRCODE = '42501';
    END IF;
    IF NEW.over_receipt_authorised_by IS NULL THEN
      NEW.over_receipt_authorised_by := auth.uid();
    END IF;
    INSERT INTO public.audit_logs (organization_id, module, action, record_id, user_id, reason, new_value)
    VALUES (NEW.organization_id, 'procurement', 'receipt.over_receipt', NEW.id::text, auth.uid(),
            NEW.over_receipt_reason,
            jsonb_build_object('ordered', _ordered, 'already_received', _already,
                               'now_received', coalesce(NEW.quantity_received,0)));
  END IF;

  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_stores_receive_goods(_order uuid, _location uuid, _lines jsonb, _attempt uuid, _notes text DEFAULT NULL::text, _over_receipt_reason text DEFAULT NULL::text, _delivery_note text DEFAULT NULL::text, _supplier_invoice text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _p record; _line jsonb; _pl record;
        _grn uuid; _number text; _prior jsonb; _count integer := 0;
        _qty numeric; _outstanding numeric; _lreason text; _post jsonb; _partial boolean := false;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;

  SELECT result INTO _prior FROM public.procurement_attempts
   WHERE organization_id=_org AND action='goods.receive' AND attempt_key=_attempt;
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;

  IF NOT (public.has_permission('procurement','receiving.manage')
          OR public.has_permission('procurement','receiving.create')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _p FROM public.purchase_orders WHERE id=_order AND organization_id=_org;
  IF _p IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_p.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF _p.status NOT IN ('approved','sent','partially-received','partially_received') THEN
    RAISE EXCEPTION 'order_not_receivable' USING ERRCODE='22023';
  END IF;
  IF _location IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.stock_locations sl WHERE sl.id=_location AND sl.organization_id=_org AND sl.active) THEN
    RAISE EXCEPTION 'store_location_required' USING ERRCODE='22023';
  END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'no_receipt_lines' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('grn:'||_order::text, 7));

  _number := public.next_document_number('goods_receipt','GRN', _p.branch_id);
  INSERT INTO public.goods_receipts (organization_id, branch_id, order_id, supplier_id, location_id,
    grn_number, status, received_at, received_by, notes, delivery_note_number, supplier_invoice_number)
  VALUES (_org, _p.branch_id, _order, _p.supplier_id, _location, _number, 'received', now(), auth.uid(),
          _notes, nullif(btrim(coalesce(_delivery_note,'')),''), nullif(btrim(coalesce(_supplier_invoice,'')),''))
  RETURNING id INTO _grn;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    SELECT * INTO _pl FROM public.purchase_order_lines
     WHERE id = (_line->>'order_line_id')::uuid AND order_id = _order;
    IF _pl IS NULL THEN RAISE EXCEPTION 'order_line_not_on_order' USING ERRCODE='22023'; END IF;

    _qty := COALESCE((_line->>'quantity_received')::numeric, 0);
    IF _qty <= 0 THEN CONTINUE; END IF;

    _lreason := nullif(btrim(coalesce(_line->>'over_receipt_reason', _over_receipt_reason, '')), '');

    _outstanding := COALESCE(_pl.quantity,0) - COALESCE(_pl.cancelled_quantity,0) - COALESCE(_pl.received_quantity,0);
    IF _qty > _outstanding + 0.0001 AND _lreason IS NULL THEN
      RAISE EXCEPTION 'over_receipt_refused: % outstanding on this line, % offered', _outstanding, _qty
        USING ERRCODE='23514';
    END IF;

    INSERT INTO public.goods_receipt_lines (organization_id, receipt_id, order_line_id, stock_item_id,
      quantity_ordered, quantity_previously_received, quantity_received, quantity_rejected, quantity_damaged,
      quantity_accepted, unit, unit_price, batch_number, expiry_date, location_id, notes,
      rejection_reason, over_receipt_reason)
    VALUES (_org, _grn, _pl.id, _pl.stock_item_id, _pl.quantity, COALESCE(_pl.received_quantity,0), _qty,
      COALESCE((_line->>'quantity_rejected')::numeric,0), COALESCE((_line->>'quantity_damaged')::numeric,0),
      GREATEST(_qty - COALESCE((_line->>'quantity_rejected')::numeric,0)
                    - COALESCE((_line->>'quantity_damaged')::numeric,0), 0),
      COALESCE(_line->>'unit', _pl.unit), COALESCE((_line->>'unit_price')::numeric, _pl.unit_price),
      nullif(_line->>'batch_number',''), (nullif(_line->>'expiry_date',''))::date,
      COALESCE((nullif(_line->>'location_id',''))::uuid, _location), nullif(_line->>'notes',''),
      nullif(btrim(coalesce(_line->>'rejection_reason','')),''),
      CASE WHEN _qty > _outstanding + 0.0001 THEN _lreason ELSE NULL END);
    _count := _count + 1;
  END LOOP;

  IF _count = 0 THEN RAISE EXCEPTION 'no_receipt_lines' USING ERRCODE='22023'; END IF;

  _post := public.inventory_post_receipt(_grn);

  SELECT EXISTS (
    SELECT 1 FROM public.purchase_order_lines pl
     WHERE pl.order_id=_order
       AND COALESCE(pl.accepted_quantity,0) + COALESCE(pl.cancelled_quantity,0) < pl.quantity
  ) INTO _partial;
  UPDATE public.goods_receipts SET is_partial=_partial WHERE id=_grn;

  _prior := jsonb_build_object('ok',true,'receipt_id',_grn,'grn_number',_number,
              'lines',_count,'posting',_post,'partial',_partial,
              'order_status',(SELECT status FROM public.purchase_orders WHERE id=_order));
  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
  VALUES (_org,'goods.receive',_attempt,_grn,_prior);
  RETURN _prior;
END $function$
;

