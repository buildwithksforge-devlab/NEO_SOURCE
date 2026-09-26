CREATE OR REPLACE FUNCTION public.neo_checkout_to_housekeeping()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _job uuid; _dept uuid; _room_no text;
BEGIN
  IF lower(coalesce(NEW.status,'')) NOT IN ('checked-out','checked_out','departed') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND lower(coalesce(OLD.status,'')) = lower(coalesce(NEW.status,'')) THEN RETURN NEW; END IF;
  IF NEW.room_id IS NULL THEN RETURN NEW; END IF;

  UPDATE rooms SET occupancy_status = 'vacant', housekeeping_status = 'dirty', updated_at = now()
   WHERE id = NEW.room_id
  RETURNING room_number INTO _room_no;

  -- A departure clean may already be open for this room (raised manually or by
  -- the checkout handoff). Reuse it rather than raising a second one.
  IF public.hk_reuse_open_job(NEW.organization_id, NEW.room_id, 'checkout-cleaning') IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO _dept FROM departments
   WHERE organization_id = NEW.organization_id
     AND public.neo_norm_key(name) LIKE 'housekeep%' LIMIT 1;

  INSERT INTO housekeeping_jobs (organization_id, branch_id, room_id, reservation_id, department_id,
                                 job_type, status, priority, inspection_required, inspection_status,
                                 due_at, location_label, idempotency_key)
  VALUES (NEW.organization_id, NEW.branch_id, NEW.room_id, NEW.id, _dept,
          'checkout-cleaning', 'pending', 'high', true, 'pending',
          now() + interval '2 hours', coalesce(_room_no, 'Room'),
          'checkout:' || NEW.id::text)
  ON CONFLICT DO NOTHING
  RETURNING id INTO _job;

  IF _job IS NOT NULL THEN
    PERFORM public.emit_domain_event(
      NEW.organization_id, NEW.branch_id, 'housekeeping.departure_clean.required', 'housekeeping',
      _job,
      jsonb_build_object('room_id', NEW.room_id, 'room_number', _room_no, 'reservation_id', NEW.id),
      'hkjob:' || _job::text || ':created', NULL);

    PERFORM public.neo_notify(NEW.organization_id, NULL, NEW.branch_id, 'operational-alert',
      format('Departure clean required — room %s', coalesce(_room_no,'')),
      'The guest has checked out. The room is out of inventory until it is cleaned and inspected.',
      '/housekeeping?job=' || _job::text, 'high', true,
      'housekeeping', _job, 'housekeeping.job_created', 'hkjob:' || _job::text || ':created');
  END IF;
  RETURN NEW;
END $function$;