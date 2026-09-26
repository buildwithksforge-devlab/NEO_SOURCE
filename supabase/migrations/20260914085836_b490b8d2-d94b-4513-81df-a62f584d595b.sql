CREATE OR REPLACE FUNCTION public.neo_event_billing_statement(_booking uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        'recorded_by', pr.full_name, 'receipt_number', p.receipt_number,
        'shift_id', p.shift_id)
        ORDER BY p.recorded_at DESC)
      FROM public.event_payments p
      LEFT JOIN public.profiles pr ON pr.id = p.recorded_by
      WHERE p.booking_id = b.id), '[]'::jsonb));
END $function$;
