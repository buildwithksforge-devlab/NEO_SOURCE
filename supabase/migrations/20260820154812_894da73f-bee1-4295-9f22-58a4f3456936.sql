
REVOKE EXECUTE ON FUNCTION public.neo_notify_approval() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_notify_task() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_notify(uuid,uuid,uuid,text,text,text,text,text,boolean,text,uuid,text,text) FROM anon, authenticated;

-- ===== Accommodation conveyor: checkout -> housekeeping -> cleaning -> inspection -> sellable =====

-- A room is only sellable when it is active, operational, vacant and clean/inspected.
CREATE OR REPLACE FUNCTION public.rooms_derive_state()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE hk text; mt text; oc text; cond text; cond_changed boolean := false;
BEGIN
  hk := lower(coalesce(NEW.housekeeping_status, 'dirty'));
  hk := CASE hk
          WHEN 'ready-for-inspection' THEN 'awaiting-inspection'
          WHEN 'cleaning' THEN 'in-progress'
          WHEN 'vacant-dirty' THEN 'dirty'
          WHEN 'vacant-clean' THEN 'clean'
          WHEN 'occupied' THEN 'clean'
          ELSE hk END;
  IF hk NOT IN ('dirty','in-progress','awaiting-inspection','clean','inspected') THEN hk := 'dirty'; END IF;

  mt := lower(coalesce(NEW.maintenance_status, 'operational'));
  mt := CASE mt
          WHEN 'in-repair' THEN 'under-maintenance'
          WHEN 'reported' THEN 'under-maintenance'
          WHEN 'maintenance' THEN 'under-maintenance'
          WHEN 'blocked' THEN 'out-of-service'
          WHEN 'ok' THEN 'operational'
          WHEN 'none' THEN 'operational'
          ELSE mt END;
  IF mt NOT IN ('operational','under-maintenance','out-of-service','out-of-order') THEN mt := 'operational'; END IF;

  oc := lower(coalesce(NEW.occupancy_status, 'vacant'));
  IF oc NOT IN ('vacant','occupied','house-use') THEN oc := 'vacant'; END IF;

  IF TG_OP = 'UPDATE' AND NEW.room_condition IS DISTINCT FROM OLD.room_condition THEN
    cond_changed := true;
  END IF;

  IF cond_changed THEN
    cond := lower(coalesce(NEW.room_condition, ''));
    IF cond = 'out-of-order' THEN
      mt := 'out-of-order';
    ELSIF cond IN ('out-of-service','blocked') THEN
      mt := 'out-of-service';
    ELSIF cond = 'maintenance' THEN
      mt := 'under-maintenance';
    ELSE
      mt := 'operational';
      IF cond = 'vacant-clean' THEN oc := 'vacant'; hk := 'clean';
      ELSIF cond = 'vacant-dirty' THEN oc := 'vacant'; hk := 'dirty';
      ELSIF cond = 'inspected' THEN oc := 'vacant'; hk := 'inspected';
      ELSIF cond = 'occupied-clean' THEN oc := 'occupied'; hk := 'clean';
      ELSIF cond = 'occupied-dirty' THEN oc := 'occupied'; hk := 'dirty';
      END IF;
    END IF;
  END IF;

  IF mt = 'out-of-order' THEN cond := 'out-of-order';
  ELSIF mt = 'out-of-service' THEN cond := 'out-of-service';
  ELSIF mt = 'under-maintenance' THEN cond := 'maintenance';
  ELSIF oc IN ('occupied','house-use') THEN
    cond := CASE WHEN hk IN ('dirty','in-progress','awaiting-inspection') THEN 'occupied-dirty' ELSE 'occupied-clean' END;
  ELSIF hk = 'inspected' THEN cond := 'inspected';
  ELSIF hk = 'clean' THEN cond := 'vacant-clean';
  ELSE cond := 'vacant-dirty';
  END IF;

  NEW.housekeeping_status := hk;
  NEW.maintenance_status := mt;
  NEW.occupancy_status := oc;
  NEW.room_condition := cond;
  NEW.sellable := (coalesce(NEW.status,'active') = 'active'
                   AND mt = 'operational'
                   AND oc = 'vacant'
                   AND hk IN ('clean','inspected'));
  IF mt = 'operational' THEN
    NEW.out_of_order_reason := NULL;
    NEW.out_of_order_from := NULL;
    NEW.out_of_order_to := NULL;
  END IF;
  RETURN NEW;
END $$;

-- Checkout raises the departure-clean job and drops the room to vacant-dirty.
CREATE OR REPLACE FUNCTION public.neo_checkout_to_housekeeping()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
    PERFORM public.neo_notify(NEW.organization_id, NULL, NEW.branch_id, 'operational-alert',
      format('Departure clean required — room %s', coalesce(_room_no,'')),
      'The guest has checked out. The room is out of inventory until it is cleaned and inspected.',
      '/housekeeping?job=' || _job::text, 'high', true,
      'housekeeping', _job, 'housekeeping.job_created', 'hkjob:' || _job::text || ':created');
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.neo_checkout_to_housekeeping() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS neo_checkout_to_housekeeping_trg ON public.reservations;
CREATE TRIGGER neo_checkout_to_housekeeping_trg AFTER INSERT OR UPDATE OF status ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.neo_checkout_to_housekeeping();

-- Cleaning and inspection push the room back through the conveyor.
CREATE OR REPLACE FUNCTION public.neo_housekeeping_room_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _room_no text;
BEGIN
  IF NEW.room_id IS NULL THEN RETURN NEW; END IF;
  SELECT room_number INTO _room_no FROM rooms WHERE id = NEW.room_id;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'in-progress' THEN
      UPDATE rooms SET housekeeping_status = 'in-progress', updated_at = now() WHERE id = NEW.room_id;
    ELSIF NEW.status = 'completed' THEN
      UPDATE rooms
         SET housekeeping_status = CASE WHEN NEW.inspection_required THEN 'awaiting-inspection' ELSE 'clean' END,
             last_cleaned_at = now(), updated_at = now()
       WHERE id = NEW.room_id;
      IF NEW.inspection_required THEN
        PERFORM public.neo_notify(NEW.organization_id, NULL, NEW.branch_id, 'operational-alert',
          format('Inspection required — room %s', coalesce(_room_no,'')),
          'Cleaning is complete. The room becomes sellable once inspection passes.',
          '/housekeeping?job=' || NEW.id::text, 'high', true,
          'housekeeping', NEW.id, 'housekeeping.awaiting_inspection',
          'hkjob:' || NEW.id::text || ':inspection');
      END IF;
    END IF;
  END IF;

  IF NEW.inspection_status IS DISTINCT FROM OLD.inspection_status THEN
    IF NEW.inspection_status = 'passed' THEN
      UPDATE rooms SET housekeeping_status = 'inspected', last_inspected_at = now(), updated_at = now()
       WHERE id = NEW.room_id;
      UPDATE notifications SET status = 'resolved', acted_at = now()
       WHERE source_module = 'housekeeping' AND source_record_id = NEW.id AND status = 'open';
    ELSIF NEW.inspection_status = 'failed' THEN
      UPDATE rooms SET housekeeping_status = 'dirty', updated_at = now() WHERE id = NEW.room_id;
      PERFORM public.neo_notify(NEW.organization_id, NEW.assignee_id, NEW.branch_id, 'operational-alert',
        format('Re-clean required — room %s', coalesce(_room_no,'')),
        'Inspection failed. The room stays out of inventory until it is re-cleaned and passed.',
        '/housekeeping?job=' || NEW.id::text, 'high', true,
        'housekeeping', NEW.id, 'housekeeping.inspection_failed',
        'hkjob:' || NEW.id::text || ':failed:' || coalesce(NEW.rework_count,0)::text);
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.neo_housekeeping_room_state() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS neo_housekeeping_room_state_trg ON public.housekeeping_jobs;
CREATE TRIGGER neo_housekeeping_room_state_trg AFTER UPDATE ON public.housekeeping_jobs
  FOR EACH ROW EXECUTE FUNCTION public.neo_housekeeping_room_state();
