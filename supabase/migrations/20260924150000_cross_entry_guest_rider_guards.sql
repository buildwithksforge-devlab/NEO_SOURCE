-- Final certification cross-entry guards
-- Guest/Stay & Dine <-> Work/POS/Folio and Rider <-> Kitchen boundaries.

CREATE OR REPLACE FUNCTION public.folio_post_charge(
  _folio uuid,
  _category text,
  _description text,
  _quantity numeric,
  _unit_price numeric,
  _tax numeric DEFAULT 0,
  _service_charge numeric DEFAULT 0,
  _discount numeric DEFAULT 0,
  _source_module text DEFAULT 'manual'::text,
  _source_record uuid DEFAULT NULL::uuid,
  _revenue_centre text DEFAULT 'rooms'::text,
  _idempotency_key text DEFAULT NULL::text,
  _correlation uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  -- System posting is a deliberate server-side handoff (for example Guest room
  -- service -> folio). In that mode the folio itself is the canonical tenant
  -- boundary. A guest profile may legitimately have no Work org, or a stale
  -- Work org from another relationship, so never prefer current_org_id() here.
  _org uuid := CASE
    WHEN public.neo_system_posting()
      THEN (SELECT organization_id FROM public.folios WHERE id = _folio)
    ELSE public.current_org_id()
  END;
  _f public.folios;
  _gross numeric;
  _net numeric;
  _id uuid;
  _key text := COALESCE(
    _idempotency_key,
    CASE
      WHEN _source_record IS NOT NULL
        THEN _source_module || ':' || _source_record::text
      ELSE 'auto:' || _folio::text
           || ':' || COALESCE(_category, '')
           || ':' || md5(COALESCE(_description, ''))
           || ':' || to_char(round(COALESCE(_quantity,1) * COALESCE(_unit_price,0), 2), 'FM9999999999990.00')
           || ':' || to_char(date_trunc('minute', now() AT TIME ZONE 'UTC'), 'YYYYMMDDHH24MI')
    END
  );
BEGIN
  IF NOT (public.has_permission('pms','folios.post_charge') OR public.neo_system_posting()) THEN
    RAISE EXCEPTION 'Not permitted to post charges';
  END IF;
  IF _org IS NULL THEN RAISE EXCEPTION 'Folio organisation could not be resolved'; END IF;

  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _f.status <> 'open' THEN RAISE EXCEPTION 'Folio is % and cannot accept charges', _f.status; END IF;

  SELECT id INTO _id FROM public.folio_lines WHERE organization_id=_org AND idempotency_key=_key;
  IF _id IS NOT NULL THEN RETURN _id; END IF;

  IF _f.corporate_account_id IS NOT NULL THEN
    PERFORM public.corp_assert_credit(_f.corporate_account_id, _f.branch_id, _f.customer_id,
      round(COALESCE(_quantity,1)*COALESCE(_unit_price,0),2) + COALESCE(_tax,0) + COALESCE(_service_charge,0));
  END IF;

  _gross := round(COALESCE(_quantity,1) * COALESCE(_unit_price,0), 2);
  _net := _gross - COALESCE(_discount,0) + COALESCE(_tax,0) + COALESCE(_service_charge,0);

  INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, customer_id, line_type,
    category, revenue_centre, reference, source_module, source_record_id, source_record_uuid, idempotency_key,
    description, quantity, unit_price, gross_amount, discount_amount, tax_amount, service_charge_amount,
    net_amount, posted_by, actor_id, correlation_id, status)
  VALUES (_org, _f.branch_id, _folio, _f.reservation_id, _f.customer_id, 'charge',
    _category, COALESCE(_revenue_centre,'rooms'), COALESCE(_source_record::text,''), _source_module,
    _source_record::text, _source_record, _key, _description, COALESCE(_quantity,1), COALESCE(_unit_price,0),
    _gross, COALESCE(_discount,0), COALESCE(_tax,0), COALESCE(_service_charge,0), _net,
    auth.uid(), auth.uid(), COALESCE(_correlation, gen_random_uuid()), 'posted')
  RETURNING id INTO _id;

  UPDATE public.folios SET
    total_charges = total_charges + _gross,
    total_discounts = total_discounts + COALESCE(_discount,0),
    total_taxes = total_taxes + COALESCE(_tax,0),
    balance = balance + _net, updated_at=now()
  WHERE id=_folio;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'pms.folio.post_charge', 'finance', _folio::text,
    jsonb_build_object('line_id',_id,'category',_category,'amount',_net,'source',_source_module,'revenue_centre',_revenue_centre));
  RETURN _id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_pos_guard_void_discount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _system boolean := auth.uid() IS NULL
                     AND coalesce(current_setting('neo.void_maintenance', true),'off') = 'on';
  _guest_cancel boolean := auth.uid() IS NOT NULL
                     AND coalesce(current_setting('neo.guest_cancel', true),'off') = 'on'
                     AND NEW.customer_id IS NOT DISTINCT FROM public.my_customer_id()
                     AND coalesce(OLD.payment_status,'unpaid') NOT IN ('paid','charged','refunded')
                     AND coalesce(OLD.status,'draft') NOT IN ('closed','voided','cancelled');
  _may_void boolean := _system OR _guest_cancel
                       OR public.has_permission('restaurant','orders.void')
                       OR public.has_permission('restaurant','approvals.approve')
                       OR public.is_org_admin();
  _may_discount boolean := _system OR public.has_permission('restaurant','orders.override')
                           OR public.has_permission('restaurant','orders.void')
                           OR public.has_permission('restaurant','approvals.approve')
                           OR public.is_org_admin();
  _old_disc numeric := coalesce(OLD.discount_total, 0);
  _new_disc numeric := coalesce(NEW.discount_total, 0);
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('voided','cancelled') THEN
    IF NOT _may_void THEN
      RAISE EXCEPTION 'void_requires_authority' USING ERRCODE = '42501',
        DETAIL = 'Voiding or cancelling a restaurant order requires explicit void authority.';
    END IF;
    INSERT INTO public.audit_logs
      (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value)
    VALUES (NEW.organization_id, auth.uid(), CASE WHEN _system THEN 'System Cleanup' WHEN _guest_cancel THEN 'Guest' ELSE '' END,
      'restaurant.order.' || NEW.status, 'restaurant', NEW.id::text,
      jsonb_build_object('status', OLD.status, 'grand_total', OLD.grand_total),
      jsonb_build_object('status', NEW.status));
  END IF;

  IF _new_disc > _old_disc + 0.0001 THEN
    IF NOT _may_discount THEN
      RAISE EXCEPTION 'discount_requires_authority' USING ERRCODE = '42501',
        DETAIL = 'Applying or increasing a discount requires explicit override authority.';
    END IF;
    INSERT INTO public.audit_logs
      (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value)
    VALUES (NEW.organization_id, auth.uid(), '', 'restaurant.order.discount', 'restaurant', NEW.id::text,
      jsonb_build_object('discount_total', _old_disc),
      jsonb_build_object('discount_total', _new_disc));
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_guest_order_cancel(_org uuid, _reference text, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _cust uuid := public.my_customer_id();
  _d public.delivery_orders;
  _started boolean;
BEGIN
  IF _cust IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in'); END IF;

  SELECT * INTO _d FROM public.delivery_orders
   WHERE organization_id = _org AND order_number = _reference AND customer_id = _cust
   FOR UPDATE;
  IF _d.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_order'); END IF;

  IF _d.order_status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'already_cancelled', true);
  END IF;

  _started := EXISTS (
    SELECT 1 FROM public.station_tickets t
     WHERE t.order_id = _d.pos_order_id
       AND t.status NOT IN ('new','queued','pending','cancelled')
  );

  IF _d.payment_status IN ('paid','charged','refunded')
     OR _d.order_status IN ('delivered','completed','collected','rejected')
     OR coalesce(_d.dispatch_status,'') IN ('picked-up','on-the-way','delivered','collected','en-route')
     OR _started THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_started');
  END IF;

  UPDATE public.station_tickets
     SET status = 'cancelled'
   WHERE order_id = _d.pos_order_id
     AND status IN ('new','queued','pending');

  PERFORM set_config('neo.guest_cancel','on',true);
  UPDATE public.pos_orders
     SET status = 'cancelled'
   WHERE id = _d.pos_order_id
     AND status <> 'cancelled';
  PERFORM set_config('neo.guest_cancel','off',true);

  UPDATE public.delivery_orders
     SET order_status = 'cancelled',
         kitchen_status = 'cancelled',
         cancelled_at = now(),
         cancellation_reason = nullif(trim(coalesce(_reason, '')), '')
   WHERE id = _d.id;

  INSERT INTO public.delivery_order_status_history
    (organization_id, delivery_order_id, status_kind, previous_status, new_status, source, reason)
  VALUES (_org, _d.id, 'order', _d.order_status, 'cancelled', 'customer',
          nullif(trim(coalesce(_reason, '')), ''));

  RETURN jsonb_build_object('ok', true, 'order_number', _d.order_number);
END;
$function$;

CREATE OR REPLACE FUNCTION public.delivery_rider_advance(_order uuid, _to text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _d public.delivery_orders;
  _rider uuid := public.my_rider_id();
BEGIN
  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order FOR UPDATE;
  IF _d.id IS NULL OR _d.rider_id IS NULL OR _d.rider_id <> _rider THEN RAISE EXCEPTION 'Delivery not assigned to you'; END IF;
  IF _to NOT IN ('pickup-pending','collected','en-route') THEN RAISE EXCEPTION 'Invalid transition'; END IF;
  IF _d.dispatch_status = _to THEN RETURN jsonb_build_object('ok', true, 'unchanged', true); END IF;

  IF _to = 'collected' THEN
    IF _d.dispatch_status NOT IN ('rider-assigned','pickup-pending') THEN RAISE EXCEPTION 'Invalid transition'; END IF;
    IF coalesce(_d.kitchen_status,'') NOT IN ('ready','completed') THEN
      RAISE EXCEPTION 'Order is not ready for pickup';
    END IF;
  END IF;

  IF _to = 'en-route' AND _d.dispatch_status <> 'collected' THEN
    RAISE EXCEPTION 'Collect the order first';
  END IF;

  UPDATE public.delivery_orders SET dispatch_status = _to,
    collected_at = CASE WHEN _to = 'collected' THEN now() ELSE collected_at END,
    order_status = CASE WHEN _to = 'collected' THEN 'collected' WHEN _to = 'en-route' THEN 'out-for-delivery' ELSE order_status END
  WHERE id = _order;

  UPDATE public.rider_profiles
     SET availability_status = CASE WHEN _to = 'en-route' THEN 'delivering' ELSE 'collecting' END
   WHERE id = _rider;

  INSERT INTO public.delivery_order_status_history
    (organization_id, delivery_order_id, status_kind, previous_status, new_status, source, changed_by)
  VALUES (_d.organization_id, _order, 'dispatch', _d.dispatch_status, _to, 'rider', auth.uid());

  RETURN jsonb_build_object('ok', true);
END;
$function$;
