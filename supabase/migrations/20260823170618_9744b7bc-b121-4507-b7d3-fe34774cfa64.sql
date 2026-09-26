CREATE OR REPLACE FUNCTION public.neo_event_billing_build(_booking uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  b public.event_bookings;
  lines int := 0;
  total numeric := 0;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('events','billing','create') OR public.has_permission('events','billing','edit')) THEN
    RAISE EXCEPTION 'The events.billing.create permission is required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO b FROM public.event_bookings
   WHERE id = _booking AND organization_id = org FOR UPDATE;
  IF b.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT public.neo_branch_in_scope(b.branch_id) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF b.billing_status = 'finalised' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_finalised',
      'detail', 'The bill is finalised. Record an adjustment instead of rebuilding it.');
  END IF;

  DELETE FROM public.event_billing_items WHERE booking_id = b.id AND generated = true;

  INSERT INTO public.event_billing_items
    (organization_id, branch_id, booking_id, category, description, quantity, unit_price,
     line_total, unit_cost, tax_rate, is_complimentary, created_by, source_key, generated)
  SELECT b.organization_id, b.branch_id, b.id, 'catering',
         'Menu — ' || m.name || ' (' || coalesce(m.service_style,'service') || ')',
         greatest(coalesce(nullif(m.guest_count,0), b.guaranteed_guests, b.expected_guests, 0), 0),
         coalesce(m.price_per_person, 0),
         greatest(coalesce(nullif(m.guest_count,0), b.guaranteed_guests, b.expected_guests, 0), 0)
           * coalesce(m.price_per_person, 0),
         coalesce(m.estimated_cost, 0), 0, false, auth.uid(), 'menu:' || m.id::text, true
    FROM public.event_menus m
   WHERE m.booking_id = b.id AND coalesce(m.price_per_person,0) > 0;

  INSERT INTO public.event_billing_items
    (organization_id, branch_id, booking_id, category, description, quantity, unit_price,
     line_total, unit_cost, tax_rate, is_complimentary, created_by, source_key, generated)
  SELECT b.organization_id, b.branch_id, b.id, 'resource',
         'Resource — ' || r.name,
         greatest(coalesce(rr.quantity,1), 1), coalesce(r.hire_price, 0),
         greatest(coalesce(rr.quantity,1), 1) * coalesce(r.hire_price, 0),
         0, 0, false, auth.uid(), 'resource:' || rr.id::text, true
    FROM public.event_resource_reservations rr
    JOIN public.event_resources r ON r.id = rr.resource_id
   WHERE rr.booking_id = b.id
     AND coalesce(rr.status,'reserved') NOT IN ('cancelled','released')
     AND coalesce(r.hire_price,0) > 0;

  INSERT INTO public.event_billing_items
    (organization_id, branch_id, booking_id, category, description, quantity, unit_price,
     line_total, unit_cost, tax_rate, is_complimentary, created_by, source_key, generated)
  SELECT b.organization_id, b.branch_id, b.id, 'vendor',
         'Vendor — ' || v.vendor_name || coalesce(' (' || nullif(v.service,'') || ')', ''),
         1, coalesce(v.agreed_cost, 0), coalesce(v.agreed_cost, 0), coalesce(v.agreed_cost, 0),
         0, false, auth.uid(), 'vendor:' || v.id::text, true
    FROM public.event_vendors v
   WHERE v.booking_id = b.id
     AND coalesce(v.status,'confirmed') NOT IN ('cancelled','declined')
     AND coalesce(v.agreed_cost,0) > 0;

  INSERT INTO public.event_billing_items
    (organization_id, branch_id, booking_id, category, description, quantity, unit_price,
     line_total, unit_cost, tax_rate, is_complimentary, created_by, source_key, generated)
  SELECT b.organization_id, b.branch_id, b.id, 'adjustment',
         'Change — ' || coalesce(nullif(cr.reason,''), cr.change_type),
         1, cr.financial_impact, cr.financial_impact, 0, 0, false, auth.uid(),
         'change:' || cr.id::text, true
    FROM public.event_change_requests cr
   WHERE cr.booking_id = b.id
     AND coalesce(cr.status,'') IN ('approved','applied')
     AND coalesce(cr.financial_impact,0) <> 0;

  SELECT count(*), coalesce(sum(CASE WHEN is_complimentary THEN 0 ELSE line_total END), 0)
    INTO lines, total
    FROM public.event_billing_items WHERE booking_id = b.id;

  UPDATE public.event_bookings
     SET total_amount = total,
         billing_status = CASE WHEN lines > 0 THEN 'draft' ELSE 'not_billed' END,
         billing_generated_at = now(),
         updated_at = now()
   WHERE id = b.id;

  INSERT INTO public.event_activity_logs (organization_id, booking_id, action, detail, actor_id)
  VALUES (b.organization_id, b.id, 'events.billing.built',
          jsonb_build_object('lines', lines, 'total', total), auth.uid());

  RETURN jsonb_build_object('ok', true, 'lines', lines, 'total', total, 'billing_status',
                            CASE WHEN lines > 0 THEN 'draft' ELSE 'not_billed' END);
END $function$;

CREATE OR REPLACE FUNCTION public.neo_event_billing_finalise(_booking uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  b public.event_bookings;
  charged numeric := 0; lines int := 0;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT public.has_permission('events','billing','approve') THEN
    RAISE EXCEPTION 'The events.billing.approve permission is required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO b FROM public.event_bookings
   WHERE id = _booking AND organization_id = org FOR UPDATE;
  IF b.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT public.neo_branch_in_scope(b.branch_id) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  SELECT count(*), coalesce(sum(CASE WHEN is_complimentary THEN 0 ELSE line_total END),0)
    INTO lines, charged FROM public.event_billing_items WHERE booking_id = b.id;
  IF lines = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_lines',
      'detail', 'Build the bill before finalising it.');
  END IF;

  UPDATE public.event_bookings
     SET billing_status = 'finalised', billed_at = now(), billed_by = auth.uid(),
         total_amount = charged, updated_at = now()
   WHERE id = b.id;

  INSERT INTO public.event_activity_logs (organization_id, booking_id, action, detail, actor_id)
  VALUES (b.organization_id, b.id, 'events.billing.finalised',
          jsonb_build_object('charged', charged, 'reason', nullif(_reason,'')), auth.uid());

  RETURN jsonb_build_object('ok', true, 'charged', charged, 'billing_status', 'finalised');
END $function$;

CREATE OR REPLACE FUNCTION public.neo_event_billing_record_payment(_booking uuid, _amount numeric, _entry_type text DEFAULT 'payment'::text, _method text DEFAULT 'cash'::text, _reference text DEFAULT NULL::text, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  b public.event_bookings;
  signed numeric;
  paid numeric := 0; charged numeric := 0; deposits numeric := 0;
  new_id uuid;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT public.has_permission('events','billing','create') THEN
    RAISE EXCEPTION 'The events.billing.create permission is required.' USING ERRCODE = '42501';
  END IF;
  IF _entry_type NOT IN ('deposit','payment','refund','credit','adjustment') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_entry_type');
  END IF;
  IF coalesce(_amount,0) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount');
  END IF;
  IF _entry_type IN ('refund','credit','adjustment') AND coalesce(trim(_reason),'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required',
      'detail', 'Refunds, credits and adjustments require a written reason.');
  END IF;

  SELECT * INTO b FROM public.event_bookings
   WHERE id = _booking AND organization_id = org FOR UPDATE;
  IF b.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT public.neo_branch_in_scope(b.branch_id) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF b.billing_status = 'not_billed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_billed',
      'detail', 'Build the bill before recording money against this event.');
  END IF;

  signed := CASE WHEN _entry_type IN ('refund','credit') THEN -abs(_amount) ELSE _amount END;

  INSERT INTO public.event_payments
    (organization_id, branch_id, booking_id, entry_type, method, amount, currency,
     reference, reason, recorded_by)
  VALUES (b.organization_id, b.branch_id, b.id, _entry_type, coalesce(_method,'cash'), signed,
          public.neo_fact_currency(org, b.branch_id), nullif(_reference,''), nullif(_reason,''), auth.uid())
  RETURNING id INTO new_id;

  SELECT coalesce(sum(amount),0) INTO paid FROM public.event_payments WHERE booking_id = b.id;
  SELECT coalesce(sum(amount),0) INTO deposits
    FROM public.event_payments WHERE booking_id = b.id AND entry_type = 'deposit';
  SELECT coalesce(sum(CASE WHEN is_complimentary THEN 0 ELSE line_total END),0) INTO charged
    FROM public.event_billing_items WHERE booking_id = b.id;

  UPDATE public.event_bookings
     SET paid_amount = paid,
         deposit_paid = deposits,
         payment_status = CASE
           WHEN paid <= 0 THEN 'unpaid'
           WHEN paid >= charged AND charged > 0 THEN 'paid'
           ELSE 'partial' END,
         updated_at = now()
   WHERE id = b.id;

  INSERT INTO public.event_activity_logs (organization_id, booking_id, action, detail, actor_id)
  VALUES (b.organization_id, b.id, 'events.billing.' || _entry_type,
          jsonb_build_object('amount', signed, 'method', coalesce(_method,'cash'),
                             'reference', nullif(_reference,''), 'reason', nullif(_reason,'')), auth.uid());

  RETURN jsonb_build_object('ok', true, 'payment_id', new_id, 'paid', paid,
                            'charged', charged, 'outstanding', charged - paid);
END $function$;

REVOKE EXECUTE ON FUNCTION public.neo_event_billing_build(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_event_billing_finalise(uuid,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_event_billing_record_payment(uuid,numeric,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_billing_build(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_event_billing_finalise(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_event_billing_record_payment(uuid,numeric,text,text,text,text) TO authenticated;