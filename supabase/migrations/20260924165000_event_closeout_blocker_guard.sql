-- Certification hardening: event close-out must respect NOT NULL blocker contract.
CREATE OR REPLACE FUNCTION public.neo_event_close_out(_booking uuid, _outcome text, _reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  b record;
  v_status text;
  v_billed numeric := 0;
  v_paid numeric := 0;
  v_reqs int := 0;
BEGIN
  IF NOT (has_permission('events','bookings.edit') OR has_permission('events','edit') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to close out events';
  END IF;

  v_status := CASE lower(COALESCE(_outcome, ''))
                WHEN 'completed' THEN 'completed'
                WHEN 'no-show'   THEN 'cancelled'
                WHEN 'cancelled' THEN 'cancelled'
                ELSE NULL END;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'invalid_outcome: choose completed, no-show or cancelled.';
  END IF;

  IF lower(COALESCE(_outcome,'')) <> 'completed' AND COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'reason_required: record why this event did not take place.';
  END IF;

  SELECT * INTO b FROM public.event_bookings
   WHERE id = _booking AND organization_id = v_org FOR UPDATE;
  IF b IS NULL THEN RAISE EXCEPTION 'Event not found'; END IF;

  IF b.status IN ('completed','closed','cancelled') THEN
    RETURN jsonb_build_object('status', b.status, 'already_closed', true);
  END IF;

  SELECT COALESCE(sum(i.line_total),0) INTO v_billed FROM public.event_billing_items i WHERE i.booking_id = _booking;
  SELECT COALESCE(sum(p.amount),0)     INTO v_paid   FROM public.event_payments p      WHERE p.booking_id = _booking;

  UPDATE public.event_department_requirements
     SET readiness = 'completed',
         blocker = '',
         updated_by = auth.uid(),
         updated_at = now()
   WHERE booking_id = _booking
     AND readiness NOT IN ('completed','ready');
  GET DIAGNOSTICS v_reqs = ROW_COUNT;

  UPDATE public.banquet_event_orders
     SET status = 'cancelled', updated_at = now()
   WHERE booking_id = _booking
     AND v_status = 'cancelled'
     AND status NOT IN ('cancelled','superseded');

  UPDATE public.event_bookings
     SET status = v_status,
         internal_notes = CONCAT_WS(E'\n', internal_notes,
           'Closed out as ' || lower(_outcome) || ' on ' || to_char(now(), 'DD Mon YYYY')
           || CASE WHEN COALESCE(btrim(_reason),'') = '' THEN '' ELSE ': ' || btrim(_reason) END),
         updated_at = now()
   WHERE id = _booking;

  BEGIN
    PERFORM public.write_audit_log('events', 'event.closed-out', _booking::text, NULL,
      jsonb_build_object('outcome', lower(_outcome), 'reason', _reason,
                         'billed', v_billed, 'paid', v_paid), _reason);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'status', v_status,
    'outcome', lower(_outcome),
    'handoffs_closed', v_reqs,
    'billed', v_billed,
    'paid', v_paid,
    'outstanding', GREATEST(v_billed - v_paid, 0)
  );
END $function$;
