ALTER TABLE public.event_billing_items
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS generated boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS event_billing_items_source_key_uidx
  ON public.event_billing_items (booking_id, source_key)
  WHERE source_key IS NOT NULL;

ALTER TABLE public.event_bookings
  ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'not_billed',
  ADD COLUMN IF NOT EXISTS billing_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS billed_at timestamptz,
  ADD COLUMN IF NOT EXISTS billed_by uuid;

CREATE TABLE IF NOT EXISTS public.event_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  entry_type text NOT NULL DEFAULT 'payment',
  method text NOT NULL DEFAULT 'cash',
  amount numeric NOT NULL,
  currency text,
  reference text,
  reason text,
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_payments_booking_idx ON public.event_payments (booking_id);
CREATE INDEX IF NOT EXISTS event_payments_org_idx ON public.event_payments (organization_id, branch_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_payments TO authenticated;
GRANT ALL ON public.event_payments TO service_role;

ALTER TABLE public.event_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_payments_view ON public.event_payments;
CREATE POLICY event_payments_view ON public.event_payments FOR SELECT TO authenticated
USING (organization_id = public.current_org_id()
       AND public.neo_branch_in_scope(branch_id)
       AND public.has_permission('events','billing','view'));

DROP POLICY IF EXISTS event_payments_write ON public.event_payments;
CREATE POLICY event_payments_write ON public.event_payments FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id()
       AND public.neo_branch_in_scope(branch_id)
       AND public.has_permission('events','billing','create'));

DROP POLICY IF EXISTS event_payments_edit ON public.event_payments;
CREATE POLICY event_payments_edit ON public.event_payments FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id()
       AND public.neo_branch_in_scope(branch_id)
       AND public.has_permission('events','billing','edit'))
WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS event_payments_delete ON public.event_payments;
CREATE POLICY event_payments_delete ON public.event_payments FOR DELETE TO authenticated
USING (organization_id = public.current_org_id()
       AND public.has_permission('events','billing','approve'));

CREATE OR REPLACE FUNCTION public.neo_event_payment_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.event_bookings;
BEGIN
  SELECT * INTO b FROM public.event_bookings WHERE id = NEW.booking_id;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown event booking.'; END IF;
  NEW.organization_id := b.organization_id;
  NEW.branch_id := b.branch_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS event_payments_scope ON public.event_payments;
CREATE TRIGGER event_payments_scope BEFORE INSERT OR UPDATE ON public.event_payments
FOR EACH ROW EXECUTE FUNCTION public.neo_event_payment_scope();

CREATE OR REPLACE FUNCTION public.neo_event_billing_build(_booking uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  INSERT INTO public.event_activity_logs (organization_id, booking_id, activity_type, description, created_by)
  VALUES (b.organization_id, b.id, 'billing',
          'Bill rebuilt from event records: ' || lines || ' line(s), total ' || total, auth.uid());

  RETURN jsonb_build_object('ok', true, 'lines', lines, 'total', total, 'billing_status',
                            CASE WHEN lines > 0 THEN 'draft' ELSE 'not_billed' END);
END $$;

REVOKE EXECUTE ON FUNCTION public.neo_event_billing_build(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_billing_build(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_event_billing_statement(_booking uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  org uuid := public.current_org_id();
  b public.event_bookings;
  charged numeric := 0; paid numeric := 0; comp numeric := 0;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT public.has_permission('events','billing','view') THEN
    RAISE EXCEPTION 'The events.billing.view permission is required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO b FROM public.event_bookings WHERE id = _booking AND organization_id = org;
  IF b.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT public.neo_branch_in_scope(b.branch_id) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(sum(CASE WHEN is_complimentary THEN 0 ELSE line_total END), 0),
         coalesce(sum(CASE WHEN is_complimentary THEN line_total ELSE 0 END), 0)
    INTO charged, comp
    FROM public.event_billing_items WHERE booking_id = b.id;

  SELECT coalesce(sum(amount), 0) INTO paid
    FROM public.event_payments WHERE booking_id = b.id;

  RETURN jsonb_build_object(
    'ok', true,
    'booking', jsonb_build_object(
      'id', b.id, 'reference', b.event_reference, 'name', b.event_name,
      'status', b.status, 'billing_status', b.billing_status,
      'event_date', b.event_date, 'branch_id', b.branch_id,
      'billed_at', b.billed_at, 'generated_at', b.billing_generated_at,
      'deposit_required', coalesce(b.deposit_required,0),
      'currency', public.neo_fact_currency(org, b.branch_id)),
    'totals', jsonb_build_object(
      'charged', charged, 'complimentary', comp, 'paid', paid,
      'outstanding', charged - paid),
    'lines', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'category', i.category, 'description', i.description,
        'quantity', i.quantity, 'unit_price', i.unit_price, 'line_total', i.line_total,
        'complimentary', i.is_complimentary, 'generated', i.generated)
        ORDER BY i.category, i.description)
      FROM public.event_billing_items i WHERE i.booking_id = b.id), '[]'::jsonb),
    'payments', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'entry_type', p.entry_type, 'method', p.method, 'amount', p.amount,
        'reference', p.reference, 'reason', p.reason, 'recorded_at', p.recorded_at,
        'recorded_by', pr.full_name)
        ORDER BY p.recorded_at DESC)
      FROM public.event_payments p
      LEFT JOIN public.profiles pr ON pr.id = p.recorded_by
      WHERE p.booking_id = b.id), '[]'::jsonb));
END $$;

REVOKE EXECUTE ON FUNCTION public.neo_event_billing_statement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_billing_statement(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_event_billing_record_payment(
  _booking uuid, _amount numeric, _entry_type text DEFAULT 'payment',
  _method text DEFAULT 'cash', _reference text DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  INSERT INTO public.event_activity_logs (organization_id, booking_id, activity_type, description, created_by)
  VALUES (b.organization_id, b.id, 'billing',
          initcap(_entry_type) || ' of ' || signed || ' recorded'
            || coalesce(' — ' || nullif(_reason,''), ''), auth.uid());

  RETURN jsonb_build_object('ok', true, 'payment_id', new_id, 'paid', paid,
                            'charged', charged, 'outstanding', charged - paid);
END $$;

REVOKE EXECUTE ON FUNCTION public.neo_event_billing_record_payment(uuid, numeric, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_billing_record_payment(uuid, numeric, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_event_billing_finalise(_booking uuid, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  INSERT INTO public.event_activity_logs (organization_id, booking_id, activity_type, description, created_by)
  VALUES (b.organization_id, b.id, 'billing',
          'Bill finalised at ' || charged || coalesce(' — ' || nullif(_reason,''), ''), auth.uid());

  RETURN jsonb_build_object('ok', true, 'charged', charged, 'billing_status', 'finalised');
END $$;

REVOKE EXECUTE ON FUNCTION public.neo_event_billing_finalise(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_billing_finalise(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_event_billing_reopen(_booking uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org uuid := public.current_org_id(); b public.event_bookings;
BEGIN
  IF NOT public.has_permission('events','billing','approve') THEN
    RAISE EXCEPTION 'The events.billing.approve permission is required.' USING ERRCODE = '42501';
  END IF;
  IF coalesce(trim(_reason),'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required');
  END IF;
  SELECT * INTO b FROM public.event_bookings WHERE id = _booking AND organization_id = org FOR UPDATE;
  IF b.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT public.neo_branch_in_scope(b.branch_id) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.finance_posting_receipts r
              WHERE r.organization_id = org AND r.source_module = 'events'
                AND r.source_id = b.id AND r.status = 'posted') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_posted',
      'detail', 'This event is already recognised in Finance. Reverse the posting first.');
  END IF;

  UPDATE public.event_bookings SET billing_status = 'draft', billed_at = NULL, billed_by = NULL,
         updated_at = now() WHERE id = b.id;
  INSERT INTO public.event_activity_logs (organization_id, booking_id, activity_type, description, created_by)
  VALUES (b.organization_id, b.id, 'billing', 'Bill reopened — ' || _reason, auth.uid());
  RETURN jsonb_build_object('ok', true, 'billing_status', 'draft');
END $$;

REVOKE EXECUTE ON FUNCTION public.neo_event_billing_reopen(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_billing_reopen(uuid, text) TO authenticated;