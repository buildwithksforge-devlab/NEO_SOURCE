-- 1. Event billing: the agreed value must read the quotation's grand total.
CREATE OR REPLACE FUNCTION public.neo_event_billing_build(_booking uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  b public.event_bookings;
  lines int := 0;
  total numeric := 0;
  agreed numeric := 0;
  components int := 0;
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

  SELECT GREATEST(COALESCE(b.total_amount,0),
                  COALESCE((SELECT q.grand_total FROM public.event_quotations q
                             WHERE q.id = b.quotation_id), 0))
    INTO agreed;

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
     AND coalesce(cr.status,'approved') = 'approved'
     AND coalesce(cr.financial_impact,0) <> 0;

  SELECT count(*), coalesce(sum(line_total),0) INTO components, total
    FROM public.event_billing_items WHERE booking_id = b.id AND generated = true;

  -- Nothing priced is configured: fall back to the agreed commercial value so the
  -- event still carries its contracted amount.
  IF components = 0 AND agreed > 0 THEN
    INSERT INTO public.event_billing_items
      (organization_id, branch_id, booking_id, category, description, quantity, unit_price,
       line_total, unit_cost, tax_rate, is_complimentary, created_by, source_key, generated)
    VALUES (b.organization_id, b.branch_id, b.id, 'package', 'Agreed event value', 1, agreed,
            agreed, 0, 0, false, auth.uid(), 'agreed:' || b.id::text, true);
    components := 1;
    total := agreed;
  END IF;

  SELECT count(*) INTO lines FROM public.event_billing_items WHERE booking_id = b.id;

  UPDATE public.event_bookings
     SET total_amount = GREATEST(total, 0),
         billing_status = CASE WHEN coalesce(billing_status,'pending') = 'finalised'
                               THEN billing_status ELSE 'built' END,
         updated_at = now()
   WHERE id = b.id;

  RETURN jsonb_build_object('ok', true, 'booking', b.id, 'lines', lines,
                            'generated', components, 'total', total, 'agreed', agreed);
END; $function$;

-- 2. A trail entry always names the caller. A signed-in user can no longer write
--    an entry attributed to somebody else.
CREATE OR REPLACE FUNCTION public.neo_audit_actor_is_caller()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.user_id := auth.uid();
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS neo_audit_actor_is_caller ON public.audit_logs;
CREATE TRIGGER neo_audit_actor_is_caller
BEFORE INSERT ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.neo_audit_actor_is_caller();

-- 3. Test-workspace removal needs room to finish; it was timing out mid-way and
--    correctly refusing to report itself as cleaned.
ALTER FUNCTION public.neo_test_purge_org(uuid) SET statement_timeout = '240s';
ALTER FUNCTION public.neo_test_purge_verify(uuid) SET statement_timeout = '120s';