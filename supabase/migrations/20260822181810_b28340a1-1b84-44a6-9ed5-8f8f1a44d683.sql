CREATE OR REPLACE FUNCTION public.neo_event_booking_transfer(_booking uuid, _branch uuid, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_old uuid;
  v_ref text;
  v_new_ref text;
  v_renumbered boolean := false;
  v_venue_released boolean := false;
  v_resources_released int := 0;
  v_rooms_released int := 0;
  v_blocks_released int := 0;
  v_enquiry uuid;
  v_quotation uuid;
  v_detached_enquiry uuid;
  v_detached_quotation uuid;
  v_traces_detached int := 0;
  v_documents_detached int := 0;
BEGIN
  IF NOT public.has_permission('events', 'bookings', 'transfer') THEN
    RAISE EXCEPTION 'The events.bookings.transfer permission is required.' USING ERRCODE = '42501';
  END IF;
  IF coalesce(trim(_reason), '') = '' THEN
    RAISE EXCEPTION 'A reason is required to transfer an event to another property.' USING ERRCODE = '22023';
  END IF;

  SELECT branch_id, event_reference, enquiry_id, quotation_id
    INTO v_old, v_ref, v_enquiry, v_quotation
  FROM public.event_bookings WHERE id = _booking AND organization_id = v_org
  FOR UPDATE;
  IF v_ref IS NULL THEN
    RAISE EXCEPTION 'Event not found in this workspace.' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.neo_branch_in_scope(v_old) OR NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'Both the current and destination property must be within your access scope.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch AND organization_id = v_org) THEN
    RAISE EXCEPTION 'The destination property does not belong to this workspace.' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch AND organization_id = v_org AND active) THEN
    RAISE EXCEPTION 'The destination property is not active.' USING ERRCODE = '23514';
  END IF;
  IF v_old = _branch THEN
    RETURN jsonb_build_object('booking_id', _booking, 'moved', false, 'event_reference', v_ref);
  END IF;

  v_new_ref := v_ref;
  IF EXISTS (
    SELECT 1 FROM public.event_bookings
    WHERE organization_id = v_org AND branch_id = _branch AND event_reference = v_ref AND id <> _booking
  ) THEN
    v_new_ref := public.next_document_number('event_booking', 'EVT', _branch);
    v_renumbered := true;
  END IF;

  -- Source records stay at their own property. Where they are incompatible with
  -- the destination they are detached from this event, never deleted.
  IF v_enquiry IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.event_enquiries e
    WHERE e.id = v_enquiry AND e.branch_id IS DISTINCT FROM _branch
  ) THEN
    v_detached_enquiry := v_enquiry;
  END IF;
  IF v_quotation IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.event_quotations q
    WHERE q.id = v_quotation AND q.branch_id IS DISTINCT FROM _branch
  ) THEN
    v_detached_quotation := v_quotation;
  END IF;

  PERFORM set_config('neo.event_transfer', 'on', true);

  UPDATE public.venue_blocks vb
     SET status = 'released',
         reason = coalesce(nullif(vb.reason, ''), '') || ' · released on property transfer'
   WHERE vb.booking_id = _booking
     AND coalesce(vb.status, '') <> 'released'
     AND NOT EXISTS (SELECT 1 FROM public.event_venues v WHERE v.id = vb.venue_id AND v.branch_id = _branch);
  GET DIAGNOSTICS v_blocks_released = ROW_COUNT;

  UPDATE public.event_resource_reservations rr
     SET status = 'released'
   WHERE rr.booking_id = _booking
     AND coalesce(rr.status, '') <> 'released'
     AND EXISTS (SELECT 1 FROM public.event_resources r WHERE r.id = rr.resource_id AND r.branch_id IS DISTINCT FROM _branch);
  GET DIAGNOSTICS v_resources_released = ROW_COUNT;

  UPDATE public.event_room_blocks
     SET rooms_blocked = 0, notes = coalesce(nullif(notes, ''), '') || ' · rooms released on property transfer'
   WHERE booking_id = _booking AND coalesce(rooms_blocked, 0) > 0;
  GET DIAGNOSTICS v_rooms_released = ROW_COUNT;

  SELECT EXISTS (
    SELECT 1 FROM public.event_bookings b
    WHERE b.id = _booking AND b.venue_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.event_venues v WHERE v.id = b.venue_id AND v.branch_id = _branch)
  ) INTO v_venue_released;

  UPDATE public.event_bookings
     SET branch_id = _branch,
         event_reference = v_new_ref,
         enquiry_id = CASE WHEN v_detached_enquiry IS NOT NULL THEN NULL ELSE enquiry_id END,
         quotation_id = CASE WHEN v_detached_quotation IS NOT NULL THEN NULL ELSE quotation_id END,
         venue_id = CASE WHEN venue_id IS NULL THEN NULL
                         WHEN EXISTS (SELECT 1 FROM public.event_venues v WHERE v.id = venue_id AND v.branch_id = _branch)
                           THEN venue_id ELSE NULL END,
         updated_by = auth.uid(), updated_at = now()
   WHERE id = _booking;

  UPDATE public.event_billing_items SET branch_id = _branch WHERE booking_id = _booking;
  UPDATE public.event_department_requirements SET branch_id = _branch WHERE booking_id = _booking;
  UPDATE public.banquet_event_orders SET branch_id = _branch WHERE booking_id = _booking;
  UPDATE public.event_feedback SET branch_id = _branch WHERE booking_id = _booking;
  UPDATE public.venue_blocks SET branch_id = _branch WHERE booking_id = _booking;
  UPDATE public.event_room_blocks SET branch_id = _branch WHERE booking_id = _booking;

  -- History and documents stay attached to the event; only an enquiry link that
  -- now points at another property is cleared, so no trace becomes cross-property.
  UPDATE public.event_activity_logs l
     SET enquiry_id = NULL
   WHERE l.booking_id = _booking
     AND l.enquiry_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.event_enquiries e WHERE e.id = l.enquiry_id AND e.branch_id IS DISTINCT FROM _branch);
  GET DIAGNOSTICS v_traces_detached = ROW_COUNT;

  UPDATE public.event_documents d
     SET enquiry_id = NULL
   WHERE d.booking_id = _booking
     AND d.enquiry_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.event_enquiries e WHERE e.id = d.enquiry_id AND e.branch_id IS DISTINCT FROM _branch);
  GET DIAGNOSTICS v_documents_detached = ROW_COUNT;

  PERFORM set_config('neo.event_transfer', '', true);

  INSERT INTO public.event_activity_logs (organization_id, booking_id, action, detail, actor_id)
  VALUES (v_org, _booking, 'events.booking.transferred',
          jsonb_build_object('event_reference', v_new_ref,
                             'old_reference', v_ref, 'new_reference', v_new_ref,
                             'reference_reallocated', v_renumbered,
                             'from_branch_id', v_old, 'to_branch_id', _branch,
                             'reason', _reason,
                             'venue_released', v_venue_released,
                             'venue_blocks_released', v_blocks_released,
                             'resource_reservations_released', v_resources_released,
                             'room_blocks_released', v_rooms_released,
                             'detached_enquiry_id', v_detached_enquiry,
                             'detached_quotation_id', v_detached_quotation,
                             'traces_detached', v_traces_detached,
                             'documents_detached', v_documents_detached),
          auth.uid());

  RETURN jsonb_build_object('booking_id', _booking, 'moved', true,
                            'event_reference', v_new_ref,
                            'old_reference', v_ref, 'new_reference', v_new_ref,
                            'reference_reallocated', v_renumbered,
                            'from_branch_id', v_old, 'to_branch_id', _branch,
                            'venue_released', v_venue_released,
                            'venue_blocks_released', v_blocks_released,
                            'resource_reservations_released', v_resources_released,
                            'room_blocks_released', v_rooms_released,
                            'detached_enquiry_id', v_detached_enquiry,
                            'detached_quotation_id', v_detached_quotation,
                            'traces_detached', v_traces_detached,
                            'documents_detached', v_documents_detached);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.neo_event_booking_transfer(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_booking_transfer(uuid, uuid, text) TO authenticated;