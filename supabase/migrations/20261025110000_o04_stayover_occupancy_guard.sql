-- NEØ O04: Preserve occupancy during housekeeping inspection.
-- Inspected describes room cleanliness, not guest checkout.
-- Existing maintenance and sellability guards remain intact.

CREATE OR REPLACE FUNCTION public.rooms_derive_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE hk text; mt text; oc text; insp text; cond text; cond_changed boolean := false;
BEGIN
  hk := lower(coalesce(NEW.housekeeping_status, 'dirty'));
  -- Accept both the underscore canonical vocabulary (written by the
  -- housekeeping routines and the canonicalisation trigger) and the legacy
  -- hyphen vocabulary. Previously an underscore value fell through to
  -- 'dirty', silently reverting completed cleaning back to a dirty room.
  hk := replace(hk, '_', '-');
  hk := CASE hk
          WHEN 'ready-for-inspection' THEN 'awaiting-inspection'
          WHEN 'cleaning' THEN 'in-progress'
          WHEN 'cleaning-in-progress' THEN 'in-progress'
          WHEN 'being-cleaned' THEN 'in-progress'
          WHEN 'cleaning-queued' THEN 'cleaning-queued'
          WHEN 'queued' THEN 'cleaning-queued'
          WHEN 'rework-required' THEN 'rework'
          WHEN 'failed' THEN 'rework'
          WHEN 'vacant-dirty' THEN 'dirty'
          WHEN 'soiled' THEN 'dirty'
          WHEN 'cleaned' THEN 'clean'
          WHEN 'vacant-clean' THEN 'clean'
          WHEN 'occupied' THEN 'clean'
          WHEN 'out-of-service' THEN 'clean'
          ELSE hk END;
  IF hk NOT IN ('dirty','cleaning-queued','in-progress','awaiting-inspection','rework','clean','inspected')
    THEN hk := 'dirty'; END IF;

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
    IF cond = 'out-of-order' THEN mt := 'out-of-order';
    ELSIF cond IN ('out-of-service','blocked') THEN mt := 'out-of-service';
    ELSIF cond = 'maintenance' THEN mt := 'under-maintenance';
    ELSE
      mt := 'operational';
      IF cond = 'vacant-clean' THEN oc := 'vacant'; hk := 'clean';
      ELSIF cond = 'vacant-dirty' THEN oc := 'vacant'; hk := 'dirty';
      ELSIF cond = 'inspected' THEN hk := 'inspected';
      ELSIF cond = 'occupied-clean' THEN oc := 'occupied'; hk := 'clean';
      ELSIF cond = 'occupied-dirty' THEN oc := 'occupied'; hk := 'dirty';
      END IF;
    END IF;
  END IF;

  insp := lower(coalesce(NEW.inspection_status,'not-required'));
  IF hk IN ('dirty','cleaning-queued','in-progress') THEN insp := 'not-required'; END IF;
  IF hk = 'awaiting-inspection' THEN insp := 'pending'; END IF;
  IF hk = 'rework' THEN insp := 'failed'; END IF;
  IF hk = 'inspected' THEN insp := 'passed'; END IF;
  IF insp NOT IN ('not-required','pending','passed','failed') THEN insp := 'not-required'; END IF;

  IF mt = 'out-of-order' THEN cond := 'out-of-order';
  ELSIF mt = 'out-of-service' THEN cond := 'out-of-service';
  ELSIF mt = 'under-maintenance' THEN cond := 'maintenance';
  ELSIF oc IN ('occupied','house-use') THEN
    cond := CASE WHEN hk IN ('clean','inspected') THEN 'occupied-clean' ELSE 'occupied-dirty' END;
  ELSIF hk = 'inspected' THEN cond := 'inspected';
  ELSIF hk = 'clean' THEN cond := 'vacant-clean';
  ELSE cond := 'vacant-dirty';
  END IF;

  NEW.housekeeping_status := hk;
  NEW.maintenance_status := mt;
  NEW.occupancy_status := oc;
  NEW.inspection_status := insp;
  NEW.room_condition := cond;
  NEW.sellable := (coalesce(NEW.status,'active') = 'active'
                   AND mt = 'operational'
                   AND oc = 'vacant'
                   AND hk IN ('clean','inspected')
                   AND insp IN ('not-required','passed'));
  IF mt = 'operational' THEN
    NEW.out_of_order_reason := NULL;
    NEW.out_of_order_from := NULL;
    NEW.out_of_order_to := NULL;
  END IF;
  RETURN NEW;
END
$function$;
