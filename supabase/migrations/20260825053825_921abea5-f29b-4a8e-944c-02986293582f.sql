-- ============================================================
-- NEØ Security department execution layer
-- Operations Manager -> Security Supervisor -> Security Guard(s)
-- ============================================================

-- 1. Posts -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.security_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid,
  name text NOT NULL,
  area text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS security_post_name_unique
  ON public.security_posts (organization_id,
    COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

GRANT SELECT ON public.security_posts TO authenticated;
GRANT ALL ON public.security_posts TO service_role;
ALTER TABLE public.security_posts ENABLE ROW LEVEL SECURITY;

-- A guard must be able to read the name of the post they stand at.
DROP POLICY IF EXISTS "security posts readable in scope" ON public.security_posts;
CREATE POLICY "security posts readable in scope"
  ON public.security_posts FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      public.has_permission('security', 'posts', 'view')
      OR public.has_permission('security', 'my-post', 'view')
    )
  );

-- 2. Guard assignments to posts -------------------------------------------
CREATE TABLE IF NOT EXISTS public.security_post_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid,
  post_id uuid NOT NULL REFERENCES public.security_posts(id) ON DELETE CASCADE,
  guard_id uuid NOT NULL,
  shift_date date NOT NULL DEFAULT (now()::date),
  shift_label text NOT NULL DEFAULT 'day',
  starts_at timestamptz,
  ends_at timestamptz,
  status text NOT NULL DEFAULT 'assigned',
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_assignment_guard_idx
  ON public.security_post_assignments (organization_id, guard_id, shift_date);
CREATE INDEX IF NOT EXISTS security_assignment_post_idx
  ON public.security_post_assignments (organization_id, post_id, shift_date);

GRANT SELECT ON public.security_post_assignments TO authenticated;
GRANT ALL ON public.security_post_assignments TO service_role;
ALTER TABLE public.security_post_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "security assignments readable in scope" ON public.security_post_assignments;
CREATE POLICY "security assignments readable in scope"
  ON public.security_post_assignments FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (guard_id = auth.uid() OR public.has_permission('security', 'posts', 'view'))
  );

-- 3. Incident reports ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.security_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid,
  incident_number text NOT NULL,
  category text NOT NULL DEFAULT 'other',
  severity text NOT NULL DEFAULT 'low',
  location text,
  post_id uuid REFERENCES public.security_posts(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  description text NOT NULL,
  people_involved text,
  witnesses text,
  action_taken text,
  status text NOT NULL DEFAULT 'reported',
  reported_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  escalated_at timestamptz,
  escalation_notes text,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS security_incident_number_unique
  ON public.security_incidents (organization_id, incident_number);
CREATE INDEX IF NOT EXISTS security_incident_status_idx
  ON public.security_incidents (organization_id, status, occurred_at DESC);

GRANT SELECT ON public.security_incidents TO authenticated;
GRANT ALL ON public.security_incidents TO service_role;
ALTER TABLE public.security_incidents ENABLE ROW LEVEL SECURITY;

-- A guard reads the incidents they reported; the Supervisor reads them all.
-- Nobody is granted DELETE: security history is permanent.
DROP POLICY IF EXISTS "security incidents readable in scope" ON public.security_incidents;
CREATE POLICY "security incidents readable in scope"
  ON public.security_incidents FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (reported_by = auth.uid() OR public.has_permission('security', 'incidents', 'view'))
  );

-- 4. Patrols ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.security_patrols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid,
  title text NOT NULL,
  assignee_id uuid,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  checkpoints jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'planned',
  started_at timestamptz,
  completed_at timestamptz,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_patrol_assignee_idx
  ON public.security_patrols (organization_id, assignee_id, scheduled_for DESC);

GRANT SELECT ON public.security_patrols TO authenticated;
GRANT ALL ON public.security_patrols TO service_role;
ALTER TABLE public.security_patrols ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "security patrols readable in scope" ON public.security_patrols;
CREATE POLICY "security patrols readable in scope"
  ON public.security_patrols FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (assignee_id = auth.uid() OR public.has_permission('security', 'patrols', 'view'))
  );

-- 5. Visitor and contractor access ----------------------------------------
CREATE TABLE IF NOT EXISTS public.security_visitor_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid,
  post_id uuid REFERENCES public.security_posts(id) ON DELETE SET NULL,
  visitor_name text NOT NULL,
  company text,
  visiting_person text,
  visiting_department text,
  purpose text,
  vehicle_registration text,
  time_in timestamptz NOT NULL DEFAULT now(),
  time_out timestamptz,
  recorded_by uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_visitor_time_idx
  ON public.security_visitor_logs (organization_id, time_in DESC);

GRANT SELECT ON public.security_visitor_logs TO authenticated;
GRANT ALL ON public.security_visitor_logs TO service_role;
ALTER TABLE public.security_visitor_logs ENABLE ROW LEVEL SECURITY;

-- A guard sees the records taken at the post they are assigned to; the
-- Supervisor sees every record.
DROP POLICY IF EXISTS "security visitor logs readable in scope" ON public.security_visitor_logs;
CREATE POLICY "security visitor logs readable in scope"
  ON public.security_visitor_logs FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      recorded_by = auth.uid()
      OR public.has_permission('security', 'visitors', 'view')
      OR EXISTS (
        SELECT 1 FROM public.security_post_assignments a
         WHERE a.organization_id = security_visitor_logs.organization_id
           AND a.post_id = security_visitor_logs.post_id
           AND a.guard_id = auth.uid()
           AND a.status <> 'closed'
      )
    )
  );

-- 6. Shift handovers -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.security_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid,
  post_id uuid REFERENCES public.security_posts(id) ON DELETE SET NULL,
  shift_label text NOT NULL DEFAULT 'day',
  outgoing_by uuid,
  incoming_by uuid,
  open_incidents integer NOT NULL DEFAULT 0,
  vehicles_on_site integer NOT NULL DEFAULT 0,
  equipment_condition text,
  notes text,
  status text NOT NULL DEFAULT 'submitted',
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_handover_idx
  ON public.security_handovers (organization_id, created_at DESC);

GRANT SELECT ON public.security_handovers TO authenticated;
GRANT ALL ON public.security_handovers TO service_role;
ALTER TABLE public.security_handovers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "security handovers readable in scope" ON public.security_handovers;
CREATE POLICY "security handovers readable in scope"
  ON public.security_handovers FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      outgoing_by = auth.uid()
      OR incoming_by = auth.uid()
      OR public.has_permission('security', 'handovers', 'view')
    )
  );

-- 7. Security tasks --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.security_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid,
  title text NOT NULL,
  details text,
  assignee_id uuid,
  post_id uuid REFERENCES public.security_posts(id) ON DELETE SET NULL,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open',
  completed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_task_assignee_idx
  ON public.security_tasks (organization_id, assignee_id, status);

GRANT SELECT ON public.security_tasks TO authenticated;
GRANT ALL ON public.security_tasks TO service_role;
ALTER TABLE public.security_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "security tasks readable in scope" ON public.security_tasks;
CREATE POLICY "security tasks readable in scope"
  ON public.security_tasks FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (assignee_id = auth.uid() OR public.has_permission('security', 'tasks', 'view'))
  );

-- Timestamps ---------------------------------------------------------------
DROP TRIGGER IF EXISTS set_security_posts_updated_at ON public.security_posts;
CREATE TRIGGER set_security_posts_updated_at BEFORE UPDATE ON public.security_posts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS set_security_assignments_updated_at ON public.security_post_assignments;
CREATE TRIGGER set_security_assignments_updated_at BEFORE UPDATE ON public.security_post_assignments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS set_security_incidents_updated_at ON public.security_incidents;
CREATE TRIGGER set_security_incidents_updated_at BEFORE UPDATE ON public.security_incidents
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS set_security_patrols_updated_at ON public.security_patrols;
CREATE TRIGGER set_security_patrols_updated_at BEFORE UPDATE ON public.security_patrols
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS set_security_visitors_updated_at ON public.security_visitor_logs;
CREATE TRIGGER set_security_visitors_updated_at BEFORE UPDATE ON public.security_visitor_logs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS set_security_handovers_updated_at ON public.security_handovers;
CREATE TRIGGER set_security_handovers_updated_at BEFORE UPDATE ON public.security_handovers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS set_security_tasks_updated_at ON public.security_tasks;
CREATE TRIGGER set_security_tasks_updated_at BEFORE UPDATE ON public.security_tasks
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================
-- Posts and assignments — Supervisor only
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_security_post_upsert(
  _name text, _area text DEFAULT NULL, _notes text DEFAULT NULL,
  _branch uuid DEFAULT NULL, _post uuid DEFAULT NULL, _active boolean DEFAULT true
)
RETURNS public.security_posts
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_posts; v_branch uuid;
BEGIN
  IF NOT public.has_permission('security', 'posts', 'create') THEN
    RAISE EXCEPTION 'Only the Security Supervisor can manage security posts';
  END IF;
  IF coalesce(btrim(_name), '') = '' THEN RAISE EXCEPTION 'Name the security post'; END IF;

  SELECT coalesce(_branch, p.branch_id) INTO v_branch FROM public.profiles p WHERE p.id = auth.uid();

  IF _post IS NOT NULL THEN
    UPDATE public.security_posts
       SET name = btrim(_name), area = nullif(btrim(_area), ''),
           notes = nullif(btrim(_notes), ''), active = coalesce(_active, true), updated_at = now()
     WHERE id = _post AND organization_id = current_org_id()
    RETURNING * INTO v_row;
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'Security post not found'; END IF;
    RETURN v_row;
  END IF;

  INSERT INTO public.security_posts (organization_id, branch_id, name, area, notes, active, created_by)
  VALUES (current_org_id(), v_branch, btrim(_name), nullif(btrim(_area), ''),
          nullif(btrim(_notes), ''), coalesce(_active, true), auth.uid())
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_post_upsert(text, text, text, uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_post_upsert(text, text, text, uuid, uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_security_assign_post(
  _post uuid, _guard uuid, _shift_date date DEFAULT NULL, _shift_label text DEFAULT 'day',
  _starts timestamptz DEFAULT NULL, _ends timestamptz DEFAULT NULL, _notes text DEFAULT NULL
)
RETURNS public.security_post_assignments
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_post_assignments; v_post public.security_posts;
BEGIN
  IF NOT public.has_permission('security', 'posts', 'edit') THEN
    RAISE EXCEPTION 'Only the Security Supervisor can assign guards to posts';
  END IF;

  SELECT * INTO v_post FROM public.security_posts
   WHERE id = _post AND organization_id = current_org_id();
  IF v_post.id IS NULL THEN RAISE EXCEPTION 'Security post not found'; END IF;
  IF _guard IS NULL THEN RAISE EXCEPTION 'Choose the guard to assign'; END IF;

  -- One guard holds one post per shift; reassigning replaces the earlier one.
  UPDATE public.security_post_assignments
     SET status = 'reassigned', updated_at = now()
   WHERE organization_id = current_org_id()
     AND guard_id = _guard
     AND shift_date = coalesce(_shift_date, now()::date)
     AND shift_label = coalesce(nullif(btrim(_shift_label), ''), 'day')
     AND status = 'assigned';

  INSERT INTO public.security_post_assignments (
    organization_id, branch_id, post_id, guard_id, shift_date, shift_label,
    starts_at, ends_at, notes, created_by
  ) VALUES (
    current_org_id(), v_post.branch_id, v_post.id, _guard,
    coalesce(_shift_date, now()::date), coalesce(nullif(btrim(_shift_label), ''), 'day'),
    _starts, _ends, nullif(btrim(_notes), ''), auth.uid()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_assign_post(uuid, uuid, date, text, timestamptz, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_assign_post(uuid, uuid, date, text, timestamptz, timestamptz, text) TO authenticated;

-- ============================================================
-- Incidents — a guard reports, the Supervisor reviews and closes
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_security_incident_create(
  _category text, _description text, _location text DEFAULT NULL,
  _severity text DEFAULT 'low', _occurred_at timestamptz DEFAULT NULL,
  _people text DEFAULT NULL, _witnesses text DEFAULT NULL, _action text DEFAULT NULL,
  _post uuid DEFAULT NULL, _branch uuid DEFAULT NULL
)
RETURNS public.security_incidents
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_incidents; v_branch uuid; v_number text; v_seq bigint;
BEGIN
  IF NOT public.has_permission('security', 'incidents', 'create') THEN
    RAISE EXCEPTION 'You do not have permission to report a security incident';
  END IF;
  IF coalesce(btrim(_description), '') = '' THEN
    RAISE EXCEPTION 'Describe what happened';
  END IF;

  SELECT coalesce(_branch, p.branch_id) INTO v_branch FROM public.profiles p WHERE p.id = auth.uid();

  SELECT count(*) + 1 INTO v_seq FROM public.security_incidents
   WHERE organization_id = current_org_id()
     AND created_at >= date_trunc('year', now());
  v_number := 'SEC-' || to_char(now(), 'YYYY') || '-' || lpad(v_seq::text, 5, '0');

  INSERT INTO public.security_incidents (
    organization_id, branch_id, incident_number, category, severity, location, post_id,
    occurred_at, description, people_involved, witnesses, action_taken, reported_by
  ) VALUES (
    current_org_id(), v_branch, v_number,
    coalesce(nullif(btrim(_category), ''), 'other'),
    coalesce(nullif(btrim(_severity), ''), 'low'),
    nullif(btrim(_location), ''), _post,
    coalesce(_occurred_at, now()), btrim(_description),
    nullif(btrim(_people), ''), nullif(btrim(_witnesses), ''),
    nullif(btrim(_action), ''), auth.uid()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_incident_create(text, text, text, text, timestamptz, text, text, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_incident_create(text, text, text, text, timestamptz, text, text, text, uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_security_incident_review(
  _incident uuid, _status text, _action text DEFAULT NULL, _escalation_notes text DEFAULT NULL
)
RETURNS public.security_incidents
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_incidents; v_allowed text[];
BEGIN
  IF NOT public.has_permission('security', 'incidents', 'edit') THEN
    RAISE EXCEPTION 'Only the Security Supervisor can review a security incident';
  END IF;

  SELECT * INTO v_row FROM public.security_incidents
   WHERE id = _incident AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Incident not found'; END IF;

  v_allowed := CASE v_row.status
    WHEN 'reported' THEN ARRAY['under-review', 'escalated', 'resolved']
    WHEN 'under-review' THEN ARRAY['escalated', 'resolved']
    WHEN 'escalated' THEN ARRAY['resolved']
    WHEN 'resolved' THEN ARRAY['closed']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'An incident cannot move from % to %', v_row.status, _status;
  END IF;

  IF _status = 'closed' AND NOT public.has_permission('security', 'incidents', 'approve') THEN
    RAISE EXCEPTION 'Closing an incident needs Security Supervisor authority';
  END IF;

  UPDATE public.security_incidents
     SET status = _status,
         action_taken = coalesce(nullif(btrim(_action), ''), action_taken),
         escalation_notes = coalesce(nullif(btrim(_escalation_notes), ''), escalation_notes),
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         escalated_at = CASE WHEN _status = 'escalated' THEN now() ELSE escalated_at END,
         closed_at = CASE WHEN _status = 'closed' THEN now() ELSE closed_at END,
         updated_at = now()
   WHERE id = _incident
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_incident_review(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_incident_review(uuid, text, text, text) TO authenticated;

-- ============================================================
-- Patrols
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_security_patrol_create(
  _title text, _scheduled timestamptz DEFAULT NULL, _checkpoints jsonb DEFAULT '[]'::jsonb,
  _assignee uuid DEFAULT NULL, _branch uuid DEFAULT NULL, _notes text DEFAULT NULL
)
RETURNS public.security_patrols
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_patrols; v_branch uuid; v_points jsonb;
BEGIN
  IF NOT public.has_permission('security', 'patrols', 'create') THEN
    RAISE EXCEPTION 'Only the Security Supervisor can set patrol requirements';
  END IF;
  IF coalesce(btrim(_title), '') = '' THEN RAISE EXCEPTION 'Name the patrol'; END IF;

  SELECT coalesce(_branch, p.branch_id) INTO v_branch FROM public.profiles p WHERE p.id = auth.uid();

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'area', coalesce(nullif(btrim(c->>'area'), ''), 'Checkpoint'),
           'due', nullif(btrim(c->>'due'), ''),
           'done_at', NULL)), '[]'::jsonb)
    INTO v_points
  FROM jsonb_array_elements(coalesce(_checkpoints, '[]'::jsonb)) c;

  INSERT INTO public.security_patrols (
    organization_id, branch_id, title, assignee_id, scheduled_for, checkpoints,
    status, notes, created_by
  ) VALUES (
    current_org_id(), v_branch, btrim(_title), _assignee, coalesce(_scheduled, now()), v_points,
    CASE WHEN _assignee IS NULL THEN 'planned' ELSE 'assigned' END,
    nullif(btrim(_notes), ''), auth.uid()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_patrol_create(text, timestamptz, jsonb, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_patrol_create(text, timestamptz, jsonb, uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_security_patrol_assign(_patrol uuid, _guard uuid)
RETURNS public.security_patrols
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_patrols;
BEGIN
  IF NOT public.has_permission('security', 'patrols', 'edit') THEN
    RAISE EXCEPTION 'Only the Security Supervisor can assign a patrol';
  END IF;

  UPDATE public.security_patrols
     SET assignee_id = _guard,
         status = CASE WHEN status = 'planned' THEN 'assigned' ELSE status END,
         updated_at = now()
   WHERE id = _patrol AND organization_id = current_org_id()
     AND status NOT IN ('completed', 'cancelled')
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Patrol not found or already finished'; END IF;
  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_patrol_assign(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_patrol_assign(uuid, uuid) TO authenticated;

-- A guard walks their own patrol: start, tick each checkpoint, complete.
CREATE OR REPLACE FUNCTION public.neo_security_patrol_checkpoint(
  _patrol uuid, _index integer
)
RETURNS public.security_patrols
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_patrols; v_points jsonb;
BEGIN
  SELECT * INTO v_row FROM public.security_patrols
   WHERE id = _patrol AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Patrol not found'; END IF;

  IF v_row.assignee_id IS DISTINCT FROM auth.uid()
     AND NOT public.has_permission('security', 'patrols', 'edit') THEN
    RAISE EXCEPTION 'You can only record a patrol assigned to you';
  END IF;
  IF v_row.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'That patrol is already finished';
  END IF;
  IF _index < 0 OR _index >= jsonb_array_length(v_row.checkpoints) THEN
    RAISE EXCEPTION 'Checkpoint not found on this patrol';
  END IF;
  IF (v_row.checkpoints -> _index ->> 'done_at') IS NOT NULL THEN
    RAISE EXCEPTION 'That checkpoint is already recorded';
  END IF;

  v_points := jsonb_set(v_row.checkpoints, ARRAY[_index::text, 'done_at'],
                        to_jsonb(now()::text), true);

  UPDATE public.security_patrols
     SET checkpoints = v_points,
         status = CASE WHEN status IN ('planned', 'assigned') THEN 'in-progress' ELSE status END,
         started_at = coalesce(started_at, now()),
         updated_at = now()
   WHERE id = _patrol
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_patrol_checkpoint(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_patrol_checkpoint(uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_security_patrol_complete(_patrol uuid, _notes text DEFAULT NULL)
RETURNS public.security_patrols
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_patrols; v_open integer;
BEGIN
  SELECT * INTO v_row FROM public.security_patrols
   WHERE id = _patrol AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Patrol not found'; END IF;

  IF v_row.assignee_id IS DISTINCT FROM auth.uid()
     AND NOT public.has_permission('security', 'patrols', 'edit') THEN
    RAISE EXCEPTION 'You can only complete a patrol assigned to you';
  END IF;
  IF v_row.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'That patrol is already finished';
  END IF;

  SELECT count(*) INTO v_open
  FROM jsonb_array_elements(v_row.checkpoints) c
  WHERE c->>'done_at' IS NULL;

  IF v_open > 0 THEN
    RAISE EXCEPTION 'Record every checkpoint before completing the patrol (% still open)', v_open;
  END IF;

  UPDATE public.security_patrols
     SET status = 'completed', completed_at = now(),
         notes = coalesce(nullif(btrim(_notes), ''), notes), updated_at = now()
   WHERE id = _patrol
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_patrol_complete(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_patrol_complete(uuid, text) TO authenticated;

-- ============================================================
-- Visitor and contractor access
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_security_visitor_record(
  _visitor_name text, _company text DEFAULT NULL, _visiting_person text DEFAULT NULL,
  _visiting_department text DEFAULT NULL, _purpose text DEFAULT NULL,
  _vehicle text DEFAULT NULL, _post uuid DEFAULT NULL, _branch uuid DEFAULT NULL,
  _notes text DEFAULT NULL
)
RETURNS public.security_visitor_logs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_visitor_logs; v_branch uuid;
BEGIN
  IF NOT public.has_permission('security', 'visitors', 'create') THEN
    RAISE EXCEPTION 'You do not have permission to record visitor access';
  END IF;
  IF coalesce(btrim(_visitor_name), '') = '' THEN RAISE EXCEPTION 'Record the visitor name'; END IF;

  SELECT coalesce(_branch, p.branch_id) INTO v_branch FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.security_visitor_logs (
    organization_id, branch_id, post_id, visitor_name, company, visiting_person,
    visiting_department, purpose, vehicle_registration, notes, recorded_by
  ) VALUES (
    current_org_id(), v_branch, _post, btrim(_visitor_name), nullif(btrim(_company), ''),
    nullif(btrim(_visiting_person), ''), nullif(btrim(_visiting_department), ''),
    nullif(btrim(_purpose), ''), upper(nullif(btrim(_vehicle), '')),
    nullif(btrim(_notes), ''), auth.uid()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_visitor_record(text, text, text, text, text, text, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_visitor_record(text, text, text, text, text, text, uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_security_visitor_checkout(_record uuid)
RETURNS public.security_visitor_logs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_visitor_logs;
BEGIN
  IF NOT public.has_permission('security', 'visitors', 'edit') THEN
    RAISE EXCEPTION 'You do not have permission to close a visitor record';
  END IF;

  UPDATE public.security_visitor_logs
     SET time_out = now(), updated_at = now()
   WHERE id = _record AND organization_id = current_org_id() AND time_out IS NULL
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Visitor record not found or already signed out'; END IF;
  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_visitor_checkout(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_visitor_checkout(uuid) TO authenticated;

-- ============================================================
-- Shift handover
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_security_handover_submit(
  _post uuid DEFAULT NULL, _shift_label text DEFAULT 'day', _incoming uuid DEFAULT NULL,
  _open_incidents integer DEFAULT 0, _vehicles integer DEFAULT 0,
  _equipment text DEFAULT NULL, _notes text DEFAULT NULL, _branch uuid DEFAULT NULL
)
RETURNS public.security_handovers
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_handovers; v_branch uuid;
BEGIN
  IF NOT public.has_permission('security', 'handovers', 'create') THEN
    RAISE EXCEPTION 'You do not have permission to record a security handover';
  END IF;

  SELECT coalesce(_branch, p.branch_id) INTO v_branch FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.security_handovers (
    organization_id, branch_id, post_id, shift_label, outgoing_by, incoming_by,
    open_incidents, vehicles_on_site, equipment_condition, notes
  ) VALUES (
    current_org_id(), v_branch, _post,
    coalesce(nullif(btrim(_shift_label), ''), 'day'), auth.uid(), _incoming,
    greatest(coalesce(_open_incidents, 0), 0), greatest(coalesce(_vehicles, 0), 0),
    nullif(btrim(_equipment), ''), nullif(btrim(_notes), '')
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_handover_submit(uuid, text, uuid, integer, integer, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_handover_submit(uuid, text, uuid, integer, integer, text, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_security_handover_acknowledge(_handover uuid)
RETURNS public.security_handovers
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_handovers;
BEGIN
  SELECT * INTO v_row FROM public.security_handovers
   WHERE id = _handover AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Handover not found'; END IF;
  IF v_row.status = 'acknowledged' THEN RAISE EXCEPTION 'That handover is already acknowledged'; END IF;

  -- Accountability between shifts: the outgoing guard cannot sign for the
  -- incoming one.
  IF v_row.outgoing_by = auth.uid() THEN
    RAISE EXCEPTION 'The incoming guard must acknowledge the handover';
  END IF;
  IF v_row.incoming_by IS NOT NULL AND v_row.incoming_by IS DISTINCT FROM auth.uid()
     AND NOT public.has_permission('security', 'handovers', 'edit') THEN
    RAISE EXCEPTION 'This handover was addressed to another guard';
  END IF;

  UPDATE public.security_handovers
     SET status = 'acknowledged', incoming_by = coalesce(incoming_by, auth.uid()),
         acknowledged_at = now(), updated_at = now()
   WHERE id = _handover
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_handover_acknowledge(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_handover_acknowledge(uuid) TO authenticated;

-- ============================================================
-- Security tasks
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_security_task_create(
  _title text, _assignee uuid DEFAULT NULL, _details text DEFAULT NULL,
  _due timestamptz DEFAULT NULL, _post uuid DEFAULT NULL, _branch uuid DEFAULT NULL
)
RETURNS public.security_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_tasks; v_branch uuid;
BEGIN
  IF NOT public.has_permission('security', 'tasks', 'create') THEN
    RAISE EXCEPTION 'Only the Security Supervisor can assign security tasks';
  END IF;
  IF coalesce(btrim(_title), '') = '' THEN RAISE EXCEPTION 'Describe the task'; END IF;

  SELECT coalesce(_branch, p.branch_id) INTO v_branch FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.security_tasks (
    organization_id, branch_id, title, details, assignee_id, post_id, due_at, created_by
  ) VALUES (
    current_org_id(), v_branch, btrim(_title), nullif(btrim(_details), ''),
    _assignee, _post, _due, auth.uid()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_task_create(text, uuid, text, timestamptz, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_task_create(text, uuid, text, timestamptz, uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_security_task_advance(_task uuid, _status text)
RETURNS public.security_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.security_tasks; v_allowed text[];
BEGIN
  SELECT * INTO v_row FROM public.security_tasks
   WHERE id = _task AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;

  IF v_row.assignee_id IS DISTINCT FROM auth.uid()
     AND NOT public.has_permission('security', 'tasks', 'edit') THEN
    RAISE EXCEPTION 'You can only update a task assigned to you';
  END IF;

  v_allowed := CASE v_row.status
    WHEN 'open' THEN ARRAY['in-progress', 'completed']
    WHEN 'in-progress' THEN ARRAY['completed']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'A task cannot move from % to %', v_row.status, _status;
  END IF;

  UPDATE public.security_tasks
     SET status = _status,
         completed_at = CASE WHEN _status = 'completed' THEN now() ELSE completed_at END,
         updated_at = now()
   WHERE id = _task
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_task_advance(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_task_advance(uuid, text) TO authenticated;

-- ============================================================
-- A guard's own workspace: their post, patrols and tasks
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_security_my_work(_branch uuid DEFAULT NULL)
RETURNS TABLE(
  source text, id uuid, title text, reference text, status text,
  due_at timestamptz, detail text, checkpoints jsonb
)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $$
  SELECT 'post'::text, a.id, p.name, coalesce(p.area, ''), a.status,
         a.ends_at, coalesce(a.shift_label, 'day'), '[]'::jsonb
  FROM public.security_post_assignments a
  JOIN public.security_posts p ON p.id = a.post_id
  WHERE a.organization_id = current_org_id()
    AND (_branch IS NULL OR a.branch_id = _branch)
    AND a.guard_id = auth.uid()
    AND a.status = 'assigned'
    AND a.shift_date >= (now()::date - 1)
    AND public.has_permission('security', 'my-post', 'view')
  UNION ALL
  SELECT 'patrol'::text, pa.id, pa.title, '', pa.status,
         pa.scheduled_for, coalesce(pa.notes, ''), pa.checkpoints
  FROM public.security_patrols pa
  WHERE pa.organization_id = current_org_id()
    AND (_branch IS NULL OR pa.branch_id = _branch)
    AND pa.assignee_id = auth.uid()
    AND pa.status NOT IN ('completed', 'cancelled')
    AND public.has_permission('security', 'my-post', 'view')
  UNION ALL
  SELECT 'task'::text, t.id, t.title, '', t.status,
         t.due_at, coalesce(t.details, ''), '[]'::jsonb
  FROM public.security_tasks t
  WHERE t.organization_id = current_org_id()
    AND (_branch IS NULL OR t.branch_id = _branch)
    AND t.assignee_id = auth.uid()
    AND t.status <> 'completed'
    AND public.has_permission('security', 'my-post', 'view')
  ORDER BY 6 NULLS LAST
  LIMIT 200;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_security_my_work(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_my_work(uuid) TO authenticated;

-- ============================================================
-- Stores: guards report a need, the Supervisor alone requisitions
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_security_requisition_from_needs(
  _needs uuid[], _required_date date DEFAULT NULL, _priority text DEFAULT 'normal', _reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_lines jsonb; v_req jsonb; v_branch uuid; v_dept uuid; v_id uuid;
BEGIN
  IF NOT public.has_permission('security', 'requisition', 'create') THEN
    RAISE EXCEPTION 'Only the Security Supervisor can send a Stores requisition for Security';
  END IF;
  IF _needs IS NULL OR array_length(_needs, 1) IS NULL THEN
    RAISE EXCEPTION 'Select at least one reported need';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'description', n.item, 'quantity_requested', n.quantity,
           'unit', n.unit, 'notes', n.notes)),
         min(n.branch_id), min(n.department_id)
    INTO v_lines, v_branch, v_dept
  FROM public.department_stock_needs n
  WHERE n.id = ANY(_needs)
    AND n.organization_id = current_org_id()
    AND n.module = 'security'
    AND n.status IN ('reported', 'acknowledged');

  IF v_lines IS NULL THEN RAISE EXCEPTION 'No open security needs match that selection'; END IF;

  v_req := public.neo_department_requisition_create(
    v_branch, v_lines, v_dept, _required_date,
    coalesce(nullif(btrim(_priority), ''), 'normal'),
    coalesce(nullif(btrim(_reason), ''), 'Security consolidated requisition'),
    NULL
  );

  v_id := nullif(v_req->>'requisition_id', '')::uuid;

  UPDATE public.department_stock_needs
     SET status = 'requisitioned', reviewed_by = auth.uid(), reviewed_at = now(),
         requisition_id = v_id, updated_at = now()
   WHERE id = ANY(_needs)
     AND organization_id = current_org_id()
     AND module = 'security'
     AND status IN ('reported', 'acknowledged');

  RETURN v_req;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_security_requisition_from_needs(uuid[], date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_security_requisition_from_needs(uuid[], date, text, text) TO authenticated;

-- ============================================================
-- Capabilities and role templates
-- ============================================================
INSERT INTO public.permissions (module, feature, action, label)
SELECT 'security', v.feature, a.action,
       'Security — ' || v.feature || ' (' || a.action || ')'
FROM (VALUES
  ('overview'), ('incidents'), ('posts'), ('patrols'), ('visitors'),
  ('handovers'), ('tasks'), ('my-post'), ('needs'), ('requisition'), ('reports')
) v(feature)
CROSS JOIN (VALUES
  ('view'), ('create'), ('edit'), ('delete'), ('approve'), ('reject'),
  ('export'), ('print'), ('override'), ('void'), ('refund')
) a(action)
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions p
   WHERE p.module = 'security' AND p.feature = v.feature AND p.action = a.action
);

-- Security Supervisor — the whole department
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'security-supervisor', 'security', v.feature, a.action
FROM (VALUES
  ('overview'), ('incidents'), ('posts'), ('patrols'), ('visitors'),
  ('handovers'), ('tasks'), ('needs'), ('requisition'), ('reports'), ('my-post')
) v(feature)
CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('approve'), ('export'), ('print')) a(action)
ON CONFLICT DO NOTHING;

-- Security Guard — own post, own patrols, own tasks, report and record only
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'security-guard', 'security', v.feature, a.action
FROM (VALUES ('my-post'), ('incidents'), ('patrols'), ('visitors'), ('handovers'), ('tasks'), ('needs')) v(feature)
CROSS JOIN (VALUES ('view'), ('create'), ('edit')) a(action)
ON CONFLICT DO NOTHING;

-- A guard never reviews, never approves and never requisitions.
DELETE FROM public.role_feature_templates
 WHERE role_key = 'security-guard'
   AND module = 'security'
   AND (action IN ('approve', 'export')
        OR feature IN ('overview', 'posts', 'requisition', 'reports'));

-- Reviewing and closing an incident is Supervisor authority: strip the guard's
-- edit on incidents while leaving them able to raise one.
DELETE FROM public.role_feature_templates
 WHERE role_key = 'security-guard'
   AND module = 'security' AND feature = 'incidents' AND action = 'edit';

SELECT public.neo_apply_feature_templates(o.id) FROM public.organizations o;