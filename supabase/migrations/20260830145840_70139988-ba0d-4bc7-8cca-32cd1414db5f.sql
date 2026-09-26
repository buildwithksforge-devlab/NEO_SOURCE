-- 1. Check-in → housekeeping occupancy event + notification -----------------
CREATE OR REPLACE FUNCTION public.neo_checkin_to_housekeeping()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _room_no text;
BEGIN
  IF lower(coalesce(NEW.status,'')) NOT IN ('checked-in','checked_in','in-house','in_house') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND lower(coalesce(OLD.status,'')) = lower(coalesce(NEW.status,'')) THEN
    RETURN NEW;
  END IF;
  IF NEW.room_id IS NULL THEN RETURN NEW; END IF;

  UPDATE public.rooms
     SET occupancy_status = 'occupied', updated_at = now()
   WHERE id = NEW.room_id
  RETURNING room_number INTO _room_no;

  PERFORM public.emit_domain_event(
    NEW.organization_id, NEW.branch_id, 'housekeeping.room.occupied', 'housekeeping',
    NEW.room_id,
    jsonb_build_object('reservation_id', NEW.id, 'room_id', NEW.room_id, 'room_number', _room_no),
    'hk-occupied:' || NEW.id::text, NULL);

  PERFORM public.neo_notify(
    NEW.organization_id, NULL, NEW.branch_id, 'operational-alert',
    format('Room %s now occupied — servicing begins', coalesce(_room_no,'')),
    'A guest has checked in. Daily servicing applies until departure.',
    '/housekeeping', 'normal', false,
    'housekeeping', NEW.room_id, 'housekeeping.room.occupied',
    'hk-occupied:' || NEW.id::text);

  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS neo_checkin_to_housekeeping_trg ON public.reservations;
CREATE TRIGGER neo_checkin_to_housekeeping_trg
AFTER INSERT OR UPDATE OF status ON public.reservations
FOR EACH ROW EXECUTE FUNCTION public.neo_checkin_to_housekeeping();

-- 2. Room released → Front Office readiness notification ---------------------
CREATE OR REPLACE FUNCTION public.neo_room_ready_front_office()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.housekeeping_status IS NOT DISTINCT FROM OLD.housekeeping_status THEN
    RETURN NEW;
  END IF;
  IF lower(coalesce(NEW.housekeeping_status,'')) NOT IN ('inspected','clean') THEN
    RETURN NEW;
  END IF;
  IF coalesce(NEW.sellable, false) IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  PERFORM public.emit_domain_event(
    NEW.organization_id, NEW.branch_id, 'housekeeping.room.ready', 'housekeeping',
    NEW.id,
    jsonb_build_object('room_id', NEW.id, 'room_number', NEW.room_number,
                       'housekeeping_status', NEW.housekeeping_status),
    'hk-ready:' || NEW.id::text || ':' || to_char(now(), 'YYYYMMDDHH24MI'), NULL);

  PERFORM public.neo_notify(
    NEW.organization_id, NULL, NEW.branch_id, 'operational-alert',
    format('Room %s is ready to sell', coalesce(NEW.room_number,'')),
    'Cleaning and inspection are complete. The room is back in sellable inventory.',
    '/pms/rooms', 'normal', false,
    'housekeeping', NEW.id, 'housekeeping.room.ready',
    'hk-ready:' || NEW.id::text || ':' || to_char(now(), 'YYYYMMDDHH24MI'));

  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS neo_room_ready_front_office_trg ON public.rooms;
CREATE TRIGGER neo_room_ready_front_office_trg
AFTER UPDATE OF housekeeping_status ON public.rooms
FOR EACH ROW EXECUTE FUNCTION public.neo_room_ready_front_office();

-- 3. Departure cleaning also records a workflow event ------------------------
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