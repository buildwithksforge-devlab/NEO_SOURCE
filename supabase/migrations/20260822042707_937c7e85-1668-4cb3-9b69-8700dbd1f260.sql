
ALTER TABLE public.group_bookings
  ADD COLUMN IF NOT EXISTS event_booking_id uuid REFERENCES public.event_bookings(id),
  ADD COLUMN IF NOT EXISTS quotation_id uuid,
  ADD COLUMN IF NOT EXISTS master_folio_id uuid,
  ADD COLUMN IF NOT EXISTS deposit_required numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_paid numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_due_date date,
  ADD COLUMN IF NOT EXISTS cancellation_terms text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS complimentary_rooms integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS release_policy text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE public.group_room_blocks
  ADD COLUMN IF NOT EXISTS rate_plan_id uuid,
  ADD COLUMN IF NOT EXISTS meal_plan_id uuid,
  ADD COLUMN IF NOT EXISTS rate_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS complimentary_rooms integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rooms_released integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cutoff_date date,
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS release_reason text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS public.group_rooming_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  group_booking_id uuid NOT NULL REFERENCES public.group_bookings(id) ON DELETE CASCADE,
  block_id uuid REFERENCES public.group_room_blocks(id),
  room_type_id uuid,
  guest_name text NOT NULL DEFAULT '',
  customer_id uuid,
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  adults integer NOT NULL DEFAULT 1,
  children integer NOT NULL DEFAULT 0,
  sharing_with text NOT NULL DEFAULT '',
  billing_instruction text NOT NULL DEFAULT 'own-account',
  complimentary boolean NOT NULL DEFAULT false,
  special_requests text NOT NULL DEFAULT '',
  reservation_id uuid,
  room_id uuid,
  status text NOT NULL DEFAULT 'listed',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS group_rooming_list_unique_guest
  ON public.group_rooming_list (group_booking_id, lower(guest_name), arrival_date)
  WHERE status <> 'cancelled';

CREATE TABLE IF NOT EXISTS public.group_block_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  group_booking_id uuid NOT NULL,
  block_id uuid,
  event_type text NOT NULL,
  previous_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL DEFAULT '',
  actor_id uuid,
  correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_block_events_booking_idx ON public.group_block_events (group_booking_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.group_rooming_list TO authenticated;
GRANT ALL ON public.group_rooming_list TO service_role;
GRANT SELECT, INSERT ON public.group_block_events TO authenticated;
GRANT ALL ON public.group_block_events TO service_role;
ALTER TABLE public.group_rooming_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_block_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_read_group_rooming_list ON public.group_rooming_list;
CREATE POLICY staff_read_group_rooming_list ON public.group_rooming_list FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
DROP POLICY IF EXISTS staff_insert_group_rooming_list ON public.group_rooming_list;
CREATE POLICY staff_insert_group_rooming_list ON public.group_rooming_list FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('pms','write'));
DROP POLICY IF EXISTS staff_update_group_rooming_list ON public.group_rooming_list;
CREATE POLICY staff_update_group_rooming_list ON public.group_rooming_list FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('pms','write'))
  WITH CHECK (organization_id = public.current_org_id());
DROP POLICY IF EXISTS staff_delete_group_rooming_list ON public.group_rooming_list;
CREATE POLICY staff_delete_group_rooming_list ON public.group_rooming_list FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());

DROP POLICY IF EXISTS staff_read_group_block_events ON public.group_block_events;
CREATE POLICY staff_read_group_block_events ON public.group_block_events FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
DROP POLICY IF EXISTS staff_insert_group_block_events ON public.group_block_events;
CREATE POLICY staff_insert_group_block_events ON public.group_block_events FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id());

DROP TRIGGER IF EXISTS trg_group_rooming_list_touch ON public.group_rooming_list;
CREATE TRIGGER trg_group_rooming_list_touch BEFORE UPDATE ON public.group_rooming_list
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.tg_group_block_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO public.group_block_events (organization_id, group_booking_id, block_id, event_type,
    previous_value, new_value, actor_id)
  VALUES (NEW.organization_id, NEW.group_booking_id, NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN 'block.created'
         WHEN COALESCE(OLD.rooms_picked_up,0) <> NEW.rooms_picked_up THEN 'block.pickup'
         WHEN COALESCE(OLD.rooms_released,0) <> NEW.rooms_released THEN 'block.released'
         ELSE 'block.updated' END,
    CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END,
    to_jsonb(NEW), auth.uid());
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_group_block_audit ON public.group_room_blocks;
CREATE TRIGGER trg_group_block_audit AFTER INSERT OR UPDATE ON public.group_room_blocks
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_block_audit();

CREATE OR REPLACE FUNCTION public.pms_room_type_availability(
  _branch uuid, _arrival date, _departure date, _for_group uuid DEFAULT NULL)
RETURNS TABLE(room_type_id uuid, room_type_name text, total_rooms integer,
              occupied_rooms integer, blocked_rooms integer, held_by_groups integer, available_rooms integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH base AS (
    SELECT rt.id, rt.name,
      (SELECT count(*) FROM public.rooms r WHERE r.room_type_id = rt.id
         AND r.organization_id = rt.organization_id AND (_branch IS NULL OR r.branch_id = _branch)
         AND r.status = 'active')::int AS total,
      (SELECT count(*) FROM public.rooms r
         JOIN public.room_assignments a ON a.room_id = r.id AND a.status='active'
          AND daterange(a.start_date, a.end_date, '[)') && daterange(_arrival, _departure, '[)')
        WHERE r.room_type_id = rt.id AND (_branch IS NULL OR r.branch_id = _branch))::int AS occupied,
      (SELECT count(*) FROM public.rooms r
         JOIN public.room_blocks b ON b.room_id = r.id AND b.status='active'
          AND daterange(b.start_date, b.end_date, '[]') && daterange(_arrival, _departure, '[)')
        WHERE r.room_type_id = rt.id AND (_branch IS NULL OR r.branch_id = _branch))::int AS blocked,
      (SELECT COALESCE(sum(GREATEST(gb.rooms_blocked - gb.rooms_picked_up - gb.rooms_released, 0)),0)
         FROM public.group_room_blocks gb
         JOIN public.group_bookings g ON g.id = gb.group_booking_id
        WHERE gb.room_type_id = rt.id AND gb.status = 'active'
          AND g.status NOT IN ('cancelled','closed')
          AND (_branch IS NULL OR g.branch_id = _branch)
          AND (_for_group IS NULL OR gb.group_booking_id <> _for_group)
          AND daterange(gb.start_date, gb.end_date, '[]') && daterange(_arrival, _departure, '[)'))::int AS held
    FROM public.room_types rt
    WHERE rt.organization_id = public.current_org_id()
      AND (_branch IS NULL OR rt.branch_id = _branch OR rt.branch_id IS NULL)
      AND rt.status = 'active'
  )
  SELECT id, name, total, occupied, blocked, held,
         GREATEST(total - occupied - blocked - held, 0)
  FROM base ORDER BY name;
$$;
REVOKE ALL ON FUNCTION public.pms_room_type_availability(uuid,date,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pms_room_type_availability(uuid,date,date,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pms_available_rooms(_branch uuid, _arrival date, _departure date,
  _room_type uuid DEFAULT NULL::uuid, _adults integer DEFAULT 1, _children integer DEFAULT 0,
  _for_group uuid DEFAULT NULL::uuid)
RETURNS TABLE(room_id uuid, room_number text, room_type_id uuid, room_type_name text, floor text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH candidates AS (
    SELECT r.id, r.room_number, r.room_type_id AS rt_id, rt.name AS rtname, r.floor,
           row_number() OVER (PARTITION BY r.room_type_id ORDER BY r.room_number DESC) AS rn
    FROM public.rooms r
    LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
    WHERE r.organization_id = public.current_org_id()
      AND (_branch IS NULL OR r.branch_id = _branch)
      AND r.status = 'active'
      AND r.maintenance_status = 'operational'
      AND (_room_type IS NULL OR r.room_type_id = _room_type)
      AND (rt.id IS NULL OR rt.max_occupancy >= (_adults + _children))
      AND NOT EXISTS (
        SELECT 1 FROM public.room_assignments a
        WHERE a.room_id = r.id AND a.status = 'active'
          AND daterange(a.start_date, a.end_date, '[)') && daterange(_arrival, _departure, '[)'))
      AND NOT EXISTS (
        SELECT 1 FROM public.room_blocks b
        WHERE b.room_id = r.id AND b.status = 'active'
          AND daterange(b.start_date, b.end_date, '[]') && daterange(_arrival, _departure, '[)'))
      AND NOT EXISTS (
        SELECT 1 FROM public.reservation_holds h
        WHERE h.room_id = r.id AND h.status = 'active' AND h.hold_expires_at > now()
          AND daterange(h.arrival_date, h.departure_date, '[)') && daterange(_arrival, _departure, '[)'))
  ), held AS (
    SELECT gb.room_type_id AS rt_id,
           COALESCE(sum(GREATEST(gb.rooms_blocked - gb.rooms_picked_up - gb.rooms_released,0)),0)::int AS qty
    FROM public.group_room_blocks gb
    JOIN public.group_bookings g ON g.id = gb.group_booking_id
    WHERE gb.status = 'active' AND g.organization_id = public.current_org_id()
      AND g.status NOT IN ('cancelled','closed')
      AND (_branch IS NULL OR g.branch_id = _branch)
      AND (_for_group IS NULL OR gb.group_booking_id <> _for_group)
      AND daterange(gb.start_date, gb.end_date, '[]') && daterange(_arrival, _departure, '[)')
    GROUP BY gb.room_type_id
  )
  SELECT c.id, c.room_number, c.rt_id, c.rtname, c.floor
  FROM candidates c
  LEFT JOIN held h ON h.rt_id = c.rt_id
  WHERE c.rn > COALESCE(h.qty, 0)
  ORDER BY c.room_number;
$$;
REVOKE ALL ON FUNCTION public.pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pms_release_expired_blocks(_org uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _released int := 0; _rec record;
BEGIN
  FOR _rec IN
    SELECT gb.*, g.organization_id AS org, g.release_policy, g.cutoff_date AS group_cutoff, g.branch_id AS bid
    FROM public.group_room_blocks gb
    JOIN public.group_bookings g ON g.id = gb.group_booking_id
    WHERE gb.status = 'active'
      AND g.status NOT IN ('cancelled','closed')
      AND COALESCE(g.release_policy,'auto') = 'auto'
      AND COALESCE(gb.cutoff_date, g.cutoff_date) IS NOT NULL
      AND COALESCE(gb.cutoff_date, g.cutoff_date) < CURRENT_DATE
      AND gb.rooms_blocked - gb.rooms_picked_up - gb.rooms_released > 0
      AND (_org IS NULL OR g.organization_id = _org)
  LOOP
    UPDATE public.group_room_blocks
      SET rooms_released = rooms_released + (_rec.rooms_blocked - _rec.rooms_picked_up - _rec.rooms_released),
          released_at = now(),
          release_reason = 'Automatic cut-off release',
          status = CASE WHEN _rec.rooms_picked_up = 0 THEN 'released' ELSE 'partially-released' END
    WHERE id = _rec.id;
    _released := _released + (_rec.rooms_blocked - _rec.rooms_picked_up - _rec.rooms_released);
    PERFORM public.neo_notify(_rec.org, NULL, _rec.bid, 'operations',
      'Group block released', 'Unused rooms released after cut-off date', '/pms/groups', 'normal', false,
      'pms', _rec.group_booking_id, 'pms.group.block_released',
      'block-release:' || _rec.id::text || ':' || CURRENT_DATE::text);
  END LOOP;
  RETURN jsonb_build_object('rooms_released', _released, 'ran_at', now());
END; $$;
REVOKE ALL ON FUNCTION public.pms_release_expired_blocks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pms_release_expired_blocks(uuid) TO authenticated, service_role;

ALTER TABLE public.waitlist_entries
  ADD COLUMN IF NOT EXISTS contact_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_phone text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_email text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS rate_plan_id uuid,
  ADD COLUMN IF NOT EXISTS quoted_rate numeric,
  ADD COLUMN IF NOT EXISTS offered_at timestamptz,
  ADD COLUMN IF NOT EXISTS offer_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS converted_at timestamptz,
  ADD COLUMN IF NOT EXISTS converted_by uuid,
  ADD COLUMN IF NOT EXISTS closed_reason text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS public.waitlist_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  waitlist_entry_id uuid NOT NULL REFERENCES public.waitlist_entries(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  previous_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL DEFAULT '',
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS waitlist_events_entry_idx ON public.waitlist_events (waitlist_entry_id, created_at DESC);
GRANT SELECT, INSERT ON public.waitlist_events TO authenticated;
GRANT ALL ON public.waitlist_events TO service_role;
ALTER TABLE public.waitlist_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_read_waitlist_events ON public.waitlist_events;
CREATE POLICY staff_read_waitlist_events ON public.waitlist_events FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());
DROP POLICY IF EXISTS staff_insert_waitlist_events ON public.waitlist_events;
CREATE POLICY staff_insert_waitlist_events ON public.waitlist_events FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id());

CREATE OR REPLACE FUNCTION public.tg_waitlist_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO public.waitlist_events (organization_id, waitlist_entry_id, event_type, previous_value, new_value, actor_id)
  VALUES (NEW.organization_id, NEW.id,
    CASE WHEN TG_OP='INSERT' THEN 'waitlist.created'
         WHEN NEW.status <> OLD.status THEN 'waitlist.' || NEW.status
         ELSE 'waitlist.updated' END,
    CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END, to_jsonb(NEW), auth.uid());
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_waitlist_audit ON public.waitlist_entries;
CREATE TRIGGER trg_waitlist_audit AFTER INSERT OR UPDATE ON public.waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION public.tg_waitlist_audit();

CREATE OR REPLACE FUNCTION public.pms_expire_waitlist(_org uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _n int;
BEGIN
  UPDATE public.waitlist_entries
    SET status = 'expired', closed_reason = 'Automatically expired', updated_at = now()
  WHERE status IN ('waiting','offered')
    AND ((expires_on IS NOT NULL AND expires_on < CURRENT_DATE)
      OR (offer_expires_at IS NOT NULL AND offer_expires_at < now())
      OR departure_date < CURRENT_DATE)
    AND (_org IS NULL OR organization_id = _org);
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN jsonb_build_object('expired', _n, 'ran_at', now());
END; $$;
REVOKE ALL ON FUNCTION public.pms_expire_waitlist(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pms_expire_waitlist(uuid) TO authenticated, service_role;

ALTER TABLE public.guest_requests
  ADD COLUMN IF NOT EXISTS request_type text NOT NULL DEFAULT 'service',
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalation_level integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalated_to uuid,
  ADD COLUMN IF NOT EXISTS resolution_notes text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS evidence_url text,
  ADD COLUMN IF NOT EXISTS feedback_rating integer,
  ADD COLUMN IF NOT EXISTS feedback_comment text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS correlation_id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE TABLE IF NOT EXISTS public.guest_request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  guest_request_id uuid NOT NULL REFERENCES public.guest_requests(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_assignee_id uuid,
  to_assignee_id uuid,
  previous_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL DEFAULT '',
  actor_id uuid,
  correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guest_request_events_req_idx ON public.guest_request_events (guest_request_id, created_at DESC);
GRANT SELECT, INSERT ON public.guest_request_events TO authenticated;
GRANT ALL ON public.guest_request_events TO service_role;
ALTER TABLE public.guest_request_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_read_guest_request_events ON public.guest_request_events;
CREATE POLICY staff_read_guest_request_events ON public.guest_request_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.guest_requests r WHERE r.id = guest_request_id
    AND public.in_my_scope(r.organization_id, r.branch_id, r.department_id, r.station_id, r.assignee_id, r.created_by)));
DROP POLICY IF EXISTS staff_insert_guest_request_events ON public.guest_request_events;
CREATE POLICY staff_insert_guest_request_events ON public.guest_request_events FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id());

CREATE OR REPLACE FUNCTION public.tg_guest_request_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _evt text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.guest_request_events (organization_id, guest_request_id, event_type,
      to_assignee_id, new_value, actor_id, correlation_id)
    VALUES (NEW.organization_id, NEW.id, 'request.created', NEW.assignee_id, to_jsonb(NEW), auth.uid(), NEW.correlation_id);
    IF NEW.assignee_id IS NOT NULL THEN
      PERFORM public.neo_notify(NEW.organization_id, NEW.assignee_id, NEW.branch_id, 'action-required',
        'New guest request assigned', COALESCE(NEW.description,''), '/pms/requests', COALESCE(NEW.priority,'normal'),
        true, 'pms', NEW.id, 'pms.guest_request.assigned', 'gr-assign:' || NEW.id::text || ':' || NEW.assignee_id::text);
    END IF;
    IF NEW.customer_id IS NOT NULL THEN
      INSERT INTO public.customer_timeline_events (organization_id, customer_id, branch_id, department_id,
        event_type, description, source_module, source_record_id, staff_user_id, customer_visible)
      VALUES (NEW.organization_id, NEW.customer_id, NEW.branch_id, NEW.department_id,
        'guest_request.created', COALESCE(NEW.description,''), 'pms', NEW.id, auth.uid(), true);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN
    INSERT INTO public.guest_request_events (organization_id, guest_request_id, event_type,
      from_assignee_id, to_assignee_id, previous_value, new_value, actor_id, correlation_id)
    VALUES (NEW.organization_id, NEW.id, 'request.reassigned', OLD.assignee_id, NEW.assignee_id,
      to_jsonb(OLD), to_jsonb(NEW), auth.uid(), NEW.correlation_id);
    IF NEW.assignee_id IS NOT NULL THEN
      PERFORM public.neo_notify(NEW.organization_id, NEW.assignee_id, NEW.branch_id, 'action-required',
        'Guest request assigned to you', COALESCE(NEW.description,''), '/pms/requests',
        COALESCE(NEW.priority,'normal'), true, 'pms', NEW.id, 'pms.guest_request.assigned',
        'gr-assign:' || NEW.id::text || ':' || NEW.assignee_id::text || ':' || NEW.updated_at::text);
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    _evt := 'request.' || NEW.status;
    INSERT INTO public.guest_request_events (organization_id, guest_request_id, event_type,
      previous_value, new_value, actor_id, correlation_id)
    VALUES (NEW.organization_id, NEW.id, _evt, to_jsonb(OLD), to_jsonb(NEW), auth.uid(), NEW.correlation_id);
    IF NEW.status = 'completed' AND NEW.customer_id IS NOT NULL THEN
      INSERT INTO public.customer_timeline_events (organization_id, customer_id, branch_id, department_id,
        event_type, description, source_module, source_record_id, staff_user_id, customer_visible)
      VALUES (NEW.organization_id, NEW.customer_id, NEW.branch_id, NEW.department_id,
        'guest_request.completed', COALESCE(NULLIF(NEW.resolution_notes,''), NEW.description, ''), 'pms', NEW.id, auth.uid(), true);
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_guest_request_lifecycle ON public.guest_requests;
CREATE TRIGGER trg_guest_request_lifecycle AFTER INSERT OR UPDATE ON public.guest_requests
  FOR EACH ROW EXECUTE FUNCTION public.tg_guest_request_lifecycle();

CREATE OR REPLACE FUNCTION public.pms_escalate_overdue_requests(_org uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _rec record; _n int := 0; _mgr uuid;
BEGIN
  FOR _rec IN
    SELECT * FROM public.guest_requests
    WHERE status NOT IN ('completed','cancelled')
      AND due_at IS NOT NULL AND due_at < now()
      AND (escalated_at IS NULL OR escalated_at < now() - interval '30 minutes')
      AND escalation_level < 3
      AND (_org IS NULL OR organization_id = _org)
  LOOP
    SELECT e.user_id INTO _mgr FROM public.employees e
     WHERE e.organization_id = _rec.organization_id AND e.department_id = _rec.department_id
       AND e.user_id IS NOT NULL AND e.user_id IS DISTINCT FROM _rec.assignee_id
     ORDER BY e.created_at LIMIT 1;

    UPDATE public.guest_requests
      SET escalation_level = escalation_level + 1, escalated_at = now(),
          escalated_to = COALESCE(_mgr, escalated_to), priority = 'urgent', updated_at = now()
    WHERE id = _rec.id;

    INSERT INTO public.guest_request_events (organization_id, guest_request_id, event_type, reason, actor_id, correlation_id)
    VALUES (_rec.organization_id, _rec.id, 'request.escalated',
      'Overdue past ' || _rec.due_at::text, NULL, _rec.correlation_id);

    PERFORM public.neo_notify(_rec.organization_id, COALESCE(_mgr, _rec.assignee_id), _rec.branch_id,
      'action-required', 'Guest request overdue', COALESCE(_rec.description,''), '/pms/requests', 'urgent',
      true, 'pms', _rec.id, 'pms.guest_request.escalated',
      'gr-esc:' || _rec.id::text || ':' || (_rec.escalation_level + 1)::text);
    _n := _n + 1;
  END LOOP;
  RETURN jsonb_build_object('escalated', _n, 'ran_at', now());
END; $$;
REVOKE ALL ON FUNCTION public.pms_escalate_overdue_requests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pms_escalate_overdue_requests(uuid) TO authenticated, service_role;
