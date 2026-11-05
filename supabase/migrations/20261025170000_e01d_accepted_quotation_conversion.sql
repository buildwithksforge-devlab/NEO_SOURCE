-- NEØ E1D: Require client acceptance before quotation conversion.
-- Preserve the original booking creation and idempotency behavior.
-- Migration source only. Do not execute during code development.

CREATE OR REPLACE FUNCTION public.neo_event_convert_quotation(_quotation uuid, _payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  q public.event_quotations%ROWTYPE;
  v_existing uuid;
  v_result jsonb;
  v_branch uuid;
BEGIN
  IF NOT public.has_permission('events', 'quotations', 'convert') THEN
    RAISE EXCEPTION 'The events.quotations.convert permission is required.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO q FROM public.event_quotations WHERE id = _quotation AND organization_id = v_org;
  IF q.id IS NULL THEN
    RAISE EXCEPTION 'Quotation not found in this workspace.' USING ERRCODE = 'P0002';
  END IF;
  IF (
       q.status IS DISTINCT FROM 'accepted'
       OR q.approved_by IS NULL
       OR q.approved_at IS NULL
       OR q.sent_at IS NULL
       OR q.responded_at IS NULL
       OR NULLIF(BTRIM(COALESCE(q.accepted_by_name, '')), '') IS NULL
     ) THEN
    RAISE EXCEPTION 'Only an accepted quotation can become an event. This quotation is %.', q.status USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_existing FROM public.event_bookings WHERE quotation_id = _quotation AND organization_id = v_org LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('booking_id', v_existing, 'created', false);
  END IF;

  v_branch := coalesce(nullif(_payload->>'branch_id', '')::uuid, q.branch_id);
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'Select a property before converting this quotation.' USING ERRCODE = '22023';
  END IF;

  v_result := public.neo_event_booking_create(
    coalesce(_payload, '{}'::jsonb) || jsonb_build_object(
      'branch_id', v_branch,
      'quotation_id', q.id,
      'enquiry_id', q.enquiry_id,
      'customer_id', q.customer_id,
      'corporate_account_id', q.corporate_account_id,
      'event_type_id', q.event_type_id,
      'venue_id', q.venue_id,
      'event_name', coalesce(nullif(_payload->>'event_name', ''), q.title, q.quotation_number),
      'event_date', coalesce(nullif(_payload->>'event_date', ''), q.event_date::text),
      'start_at', coalesce(nullif(_payload->>'start_at', ''),
                           (coalesce(q.event_date, current_date) + coalesce(q.start_time, '09:00'::time))::text),
      'end_at', coalesce(nullif(_payload->>'end_at', ''),
                         (coalesce(q.event_date, current_date) + coalesce(q.end_time, '17:00'::time))::text),
      'expected_guests', coalesce(nullif(_payload->>'expected_guests', ''), q.guest_count::text),
      'total_amount', coalesce(q.grand_total, 0)::text,
      'deposit_required', coalesce(q.deposit_amount, 0)::text,
      'status', coalesce(nullif(_payload->>'status', ''), 'confirmed'),
      'source', 'quotation'
    ));

  INSERT INTO public.event_activity_logs (organization_id, booking_id, enquiry_id, action, detail, actor_id)
  VALUES (v_org, (v_result->>'booking_id')::uuid, q.enquiry_id, 'events.quotation.converted',
          jsonb_build_object('quotation_number', q.quotation_number, 'branch_id', v_branch), auth.uid());

  RETURN v_result;
END
$$;
