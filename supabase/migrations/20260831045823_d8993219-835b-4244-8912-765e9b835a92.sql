CREATE OR REPLACE FUNCTION public.pms_assign_room(_reservation uuid, _room uuid, _reason text DEFAULT ''::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _res public.reservations;
  _candidate public.rooms;
  _prev uuid;
  _id uuid;
BEGIN
  IF NOT public.has_permission('pms','rooms.assign') THEN
    RAISE EXCEPTION 'Not permitted to assign rooms';
  END IF;

  SELECT * INTO _res
    FROM public.reservations
   WHERE id = _reservation AND organization_id = _org
   FOR UPDATE;
  IF _res.id IS NULL THEN RAISE EXCEPTION 'Reservation not found'; END IF;
  IF _res.status IN ('cancelled','checked-out','no-show') THEN
    RAISE EXCEPTION 'This reservation can no longer receive a room';
  END IF;

  SELECT * INTO _candidate
    FROM public.rooms
   WHERE id = _room AND organization_id = _org AND branch_id = _res.branch_id
   FOR UPDATE;
  IF _candidate.id IS NULL THEN
    RAISE EXCEPTION 'Room does not belong to this reservation property';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.pms_available_rooms(
        _res.branch_id, _res.arrival_date, _res.departure_date,
        _res.room_type_id, _res.adults, _res.children, _res.group_booking_id
      ) a
     WHERE a.room_id = _room
  ) AND _res.room_id IS DISTINCT FROM _room THEN
    RAISE EXCEPTION 'Room % is no longer available for these stay dates', _candidate.room_number;
  END IF;

  SELECT room_id INTO _prev
    FROM public.room_assignments
   WHERE reservation_id = _reservation AND status = 'active'
   LIMIT 1;

  IF _prev = _room THEN
    SELECT id INTO _id FROM public.room_assignments
     WHERE reservation_id = _reservation AND room_id = _room AND status = 'active'
     LIMIT 1;
    RETURN _id;
  END IF;

  UPDATE public.room_assignments
     SET status = 'released', updated_at = now()
   WHERE reservation_id = _reservation AND status = 'active';

  INSERT INTO public.room_assignments
    (organization_id, branch_id, reservation_id, stay_id, room_id,
     start_date, end_date, previous_room_id, reason, assigned_by)
  VALUES
    (_org, _res.branch_id, _reservation,
     (SELECT id FROM public.stays WHERE reservation_id = _reservation),
     _room, _res.arrival_date, _res.departure_date, _prev, COALESCE(_reason,''), auth.uid())
  RETURNING id INTO _id;

  UPDATE public.reservations SET room_id = _room, updated_at = now() WHERE id = _reservation;
  INSERT INTO public.reservation_history
    (organization_id, reservation_id, action, field, previous_value, new_value, reason, changed_by)
  VALUES
    (_org, _reservation, 'room.assign', 'room_id', _prev::text, _room::text, _reason, auth.uid());
  INSERT INTO public.audit_logs
    (organization_id, branch_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES
    (_org, _res.branch_id, auth.uid(), '', 'pms.room.assign', 'front-office', _reservation::text,
     jsonb_build_object('room_id', _prev), jsonb_build_object('room_id', _room), _reason);
  RETURN _id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.pms_transfer_room(_reservation uuid, _to_room uuid, _reason text, _move_type text DEFAULT 'transfer'::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _stay public.stays;
  _res public.reservations;
  _from uuid;
  _id uuid;
  _to public.rooms;
BEGIN
  IF NOT public.has_permission('pms','rooms.transfer') THEN RAISE EXCEPTION 'Not permitted to transfer rooms'; END IF;
  IF btrim(COALESCE(_reason,'')) = '' THEN RAISE EXCEPTION 'A reason is required for a room move'; END IF;

  SELECT * INTO _stay FROM public.stays
   WHERE reservation_id = _reservation AND organization_id = _org FOR UPDATE;
  IF _stay.id IS NULL OR _stay.status <> 'in-house' THEN RAISE EXCEPTION 'No in-house stay for this reservation'; END IF;
  SELECT * INTO _res FROM public.reservations WHERE id = _reservation AND organization_id = _org FOR UPDATE;
  SELECT * INTO _to FROM public.rooms
   WHERE id = _to_room AND organization_id = _org AND branch_id = _stay.branch_id FOR UPDATE;
  IF _to.id IS NULL THEN RAISE EXCEPTION 'Destination room not found in this property'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.pms_available_rooms(
      _stay.branch_id, current_date, GREATEST(_stay.expected_departure, current_date + 1),
      _to.room_type_id, _res.adults, _res.children, _res.group_booking_id
    ) a WHERE a.room_id = _to_room
  ) THEN
    RAISE EXCEPTION 'Destination room % is no longer available', _to.room_number;
  END IF;

  _from := _stay.room_id;
  UPDATE public.room_assignments SET status = 'moved', end_date = GREATEST(start_date + 1, current_date), updated_at = now()
   WHERE reservation_id = _reservation AND status = 'active';
  INSERT INTO public.room_assignments
    (organization_id, branch_id, reservation_id, stay_id, room_id, start_date, end_date,
     previous_room_id, reason, assignment_type, assigned_by)
  VALUES
    (_org, _stay.branch_id, _reservation, _stay.id, _to_room, current_date,
     GREATEST(_stay.expected_departure, current_date + 1), _from, _reason, _move_type, auth.uid())
  RETURNING id INTO _id;

  UPDATE public.stays SET room_id = _to_room, updated_at = now() WHERE id = _stay.id;
  UPDATE public.reservations SET room_id = _to_room, updated_at = now() WHERE id = _reservation;
  PERFORM set_config('neo.system_posting', 'on', true);
  PERFORM public.ops_set_room_status(_from, 'dirty', 'operational', 'Guest transferred out', 'pms', _reservation, 'vacant');
  PERFORM public.ops_set_room_status(_to_room, 'occupied', 'operational', 'Guest transferred in', 'pms', _reservation, 'occupied');

  INSERT INTO public.room_move_history
    (organization_id, reservation_id, stay_id, from_room_id, to_room_id, move_type, reason, moved_by)
  VALUES (_org, _reservation, _stay.id, _from, _to_room, _move_type, _reason, auth.uid());
  INSERT INTO public.tasks
    (organization_id, branch_id, reference, title, description, created_by, priority, status)
  VALUES (_org, _stay.branch_id, 'HK-MV-' || left(_id::text,8), 'Clean vacated room',
          'Guest transferred out. Room requires cleaning.', auth.uid(), 'high', 'open');
  INSERT INTO public.audit_logs
    (organization_id, branch_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, _stay.branch_id, auth.uid(), '', 'pms.room.transfer', 'front-office', _reservation::text,
          jsonb_build_object('room_id',_from), jsonb_build_object('room_id',_to_room), _reason);
  RETURN _id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_reservation_deposit_record(
  _reservation uuid, _amount numeric, _method text DEFAULT 'cash'::text,
  _reference text DEFAULT NULL::text, _idempotency_key text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _res public.reservations;
  _id uuid;
  _existing uuid;
  _post jsonb;
BEGIN
  IF NOT (public.has_permission('pms','reservations.edit') OR public.has_permission('finance','collections.record_payment')) THEN
    RAISE EXCEPTION 'Not permitted to record a reservation deposit';
  END IF;
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'A deposit must be greater than zero'; END IF;
  IF NULLIF(btrim(COALESCE(_idempotency_key,'')), '') IS NULL THEN RAISE EXCEPTION 'A deposit idempotency key is required'; END IF;

  SELECT * INTO _res FROM public.reservations
   WHERE id = _reservation AND organization_id = _org FOR UPDATE;
  IF _res.id IS NULL THEN RAISE EXCEPTION 'Reservation not found'; END IF;

  SELECT id INTO _existing FROM public.reservation_deposits
   WHERE organization_id = _org AND idempotency_key = _idempotency_key;
  IF _existing IS NOT NULL THEN
    _post := public.neo_deposit_post(_existing, true);
    RETURN jsonb_build_object('deposit_id', _existing, 'idempotent', true,
      'position', public.neo_reservation_deposit_position(_reservation), 'finance', _post);
  END IF;

  INSERT INTO public.reservation_deposits
    (organization_id, branch_id, reservation_id, customer_id, amount, method,
     reference, received_by, idempotency_key, notes)
  VALUES
    (_org, _res.branch_id, _reservation, _res.customer_id, round(_amount,2),
     COALESCE(NULLIF(lower(_method),''),'cash'), NULLIF(btrim(COALESCE(_reference,'')),''),
     auth.uid(), _idempotency_key, _notes)
  RETURNING id INTO _id;

  UPDATE public.reservations r
     SET deposit_paid = (SELECT COALESCE(sum(d.amount),0) FROM public.reservation_deposits d
                          WHERE d.reservation_id = _reservation AND d.status IN ('held','applied')),
         updated_at = now()
   WHERE r.id = _reservation;

  _post := public.neo_deposit_post(_id, true);
  RETURN jsonb_build_object('deposit_id', _id, 'idempotent', false,
    'position', public.neo_reservation_deposit_position(_reservation), 'finance', _post);
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_reservation_deposit_record(uuid,numeric,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reservation_deposit_record(uuid,numeric,text,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_maintenance_work_order_create(_payload jsonb, _idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  _room uuid := NULLIF(_payload->>'room_id','')::uuid;
  _asset uuid := NULLIF(_payload->>'asset_id','')::uuid;
  _department uuid := NULLIF(_payload->>'requesting_department_id','')::uuid;
  _description text := btrim(COALESCE(_payload->>'description',''));
  _priority text := COALESCE(NULLIF(_payload->>'priority',''),'normal');
  _blocks boolean := COALESCE((_payload->>'blocks_room')::boolean, false);
  _severity text := COALESCE(NULLIF(_payload->>'block_status',''),'out-of-order');
  _existing public.maintenance_work_orders;
  _wo public.maintenance_work_orders;
  _number text;
  _room_state jsonb;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No active organisation'; END IF;
  IF NOT (public.has_permission('maintenance','edit') OR public.has_permission('housekeeping','edit')
          OR public.has_permission('laundry','edit') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to report maintenance faults';
  END IF;
  IF _description = '' THEN RAISE EXCEPTION 'Describe the fault before reporting it'; END IF;
  IF NULLIF(btrim(COALESCE(_idempotency_key,'')), '') IS NULL THEN RAISE EXCEPTION 'A work-order idempotency key is required'; END IF;
  IF _branch IS NULL OR NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch AND organization_id = _org) THEN
    RAISE EXCEPTION 'Select a valid property';
  END IF;
  IF _room IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.rooms WHERE id = _room AND organization_id = _org AND branch_id = _branch
  ) THEN RAISE EXCEPTION 'The selected room does not belong to this property'; END IF;
  IF _asset IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.assets WHERE id = _asset AND organization_id = _org AND (branch_id IS NULL OR branch_id = _branch)
  ) THEN RAISE EXCEPTION 'The selected asset does not belong to this property'; END IF;

  SELECT * INTO _existing FROM public.maintenance_work_orders
   WHERE organization_id = _org AND idempotency_key = _idempotency_key;
  IF _existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'work_order_id', _existing.id,
      'work_order_number', _existing.work_order_number, 'blocks_room', _existing.blocks_room);
  END IF;

  _number := public.next_document_number('work-order');
  INSERT INTO public.maintenance_work_orders
    (organization_id, branch_id, work_order_number, requesting_department_id, requested_by,
     room_id, location_label, asset_id, fault_category, description, priority, operational_impact,
     guest_impact, attachments, status, blocks_room, block_status, source_module, source_record_id,
     idempotency_key, created_by)
  VALUES
    (_org, _branch, _number, _department, auth.uid(), _room, NULLIF(_payload->>'location_label',''),
     _asset, COALESCE(NULLIF(_payload->>'fault_category',''),'other'), _description, _priority,
     NULLIF(_payload->>'operational_impact',''), COALESCE((_payload->>'guest_impact')::boolean,false),
     COALESCE(_payload->'attachments','[]'::jsonb), 'new', _blocks AND _room IS NOT NULL,
     CASE WHEN _blocks AND _room IS NOT NULL THEN _severity ELSE NULL END,
     COALESCE(NULLIF(_payload->>'source_module',''),'maintenance'),
     NULLIF(_payload->>'source_record_id','')::uuid, _idempotency_key, auth.uid())
  RETURNING * INTO _wo;

  INSERT INTO public.work_order_status_history
    (organization_id, work_order_id, previous_status, new_status, reason, changed_by)
  VALUES (_org, _wo.id, NULL, 'new', 'Work order created', auth.uid());

  IF _blocks AND _room IS NOT NULL THEN
    PERFORM set_config('neo.system_posting', 'on', true);
    _room_state := public.ops_set_room_status(_room, NULL, _severity, _description, 'maintenance', _wo.id, NULL);
  END IF;

  INSERT INTO public.audit_logs
    (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, _branch, auth.uid(), '', 'maintenance.work_order.created', 'maintenance', _wo.id::text,
    jsonb_build_object('work_order_number',_number,'room_id',_room,'asset_id',_asset,
                       'blocks_room',_wo.blocks_room,'room_state',_room_state));

  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'work_order_id', _wo.id,
    'work_order_number', _number, 'blocks_room', _wo.blocks_room, 'room_state', _room_state);
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_maintenance_work_order_create(jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_maintenance_work_order_create(jsonb,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.pos_post_room_charge(_order_id uuid, _folio_id uuid, _idempotency_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _order public.pos_orders;
  _folio public.folios;
  _line uuid;
  _prior text;
  _base numeric;
BEGIN
  IF NOT public.has_permission('pos','room_charge.post') THEN RAISE EXCEPTION 'Not permitted to post room charges'; END IF;
  SELECT * INTO _order FROM public.pos_orders WHERE id = _order_id AND organization_id = _org FOR UPDATE;
  IF _order.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF _order.folio_post_status = 'posted' THEN
    SELECT id INTO _line FROM public.folio_lines
     WHERE organization_id = _org AND idempotency_key = _idempotency_key LIMIT 1;
    IF _line IS NOT NULL THEN RETURN _line; END IF;
    RAISE EXCEPTION 'Order already posted to a folio';
  END IF;
  IF _order.status NOT IN ('sent','accepted','in-preparation','partially-ready','ready','partially-served','served','awaiting-payment') THEN
    RAISE EXCEPTION 'Bill % cannot be charged to a room from status "%": send it to production first', _order.order_number, _order.status;
  END IF;
  SELECT * INTO _folio FROM public.folios WHERE id = _folio_id AND organization_id = _org FOR UPDATE;
  IF _folio.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _folio.branch_id IS DISTINCT FROM _order.branch_id THEN RAISE EXCEPTION 'Order and folio belong to different properties'; END IF;
  IF _folio.status <> 'open' THEN RAISE EXCEPTION 'Folio is not open'; END IF;
  SELECT id INTO _line FROM public.folio_lines WHERE organization_id = _org AND idempotency_key = _idempotency_key LIMIT 1;
  IF _line IS NOT NULL THEN RETURN _line; END IF;

  _base := round(COALESCE(_order.grand_total,0) - COALESCE(_order.tax_total,0)
                 - COALESCE(_order.service_charge_total,0) + COALESCE(_order.discount_total,0), 2);
  IF _base < 0 OR round(_base - COALESCE(_order.discount_total,0) + COALESCE(_order.tax_total,0)
      + COALESCE(_order.service_charge_total,0),2) <> round(COALESCE(_order.grand_total,0),2) THEN
    RAISE EXCEPTION 'Posting blocked — source integrity mismatch';
  END IF;

  _prior := COALESCE(current_setting('neo.system_posting', true), 'off');
  PERFORM set_config('neo.system_posting', 'on', true);
  _line := public.folio_post_charge(
    _folio_id, 'food-beverage', 'POS ' || _order.order_number || ' (' || _order.order_type || ')',
    1, _base, _order.tax_total, _order.service_charge_total, _order.discount_total,
    'pos', _order_id, 'fnb', _idempotency_key, NULL);
  UPDATE public.pos_orders
     SET folio_post_status = 'posted', folio_id = _folio_id, payment_status = 'paid',
         status = 'charged-to-room', closed_at = now()
   WHERE id = _order_id;
  PERFORM set_config('neo.system_posting', _prior, true);

  PERFORM public.emit_domain_event(_org, _order.branch_id, 'pos.room_charge.posted', 'pos', _order_id,
    jsonb_build_object('orderId',_order_id,'folioId',_folio_id,'amount',_order.grand_total,
                       'tax',_order.tax_total,'serviceCharge',_order.service_charge_total),
    _idempotency_key, _order.customer_id);
  INSERT INTO public.audit_logs
    (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _order.branch_id, auth.uid(), 'pos.room_charge.post', 'pos', _order_id,
    jsonb_build_object('folioId',_folio_id,'gross',_order.grand_total,'tax',_order.tax_total,
                       'serviceCharge',_order.service_charge_total,'folioLineId',_line));
  RETURN _line;
END;
$function$;