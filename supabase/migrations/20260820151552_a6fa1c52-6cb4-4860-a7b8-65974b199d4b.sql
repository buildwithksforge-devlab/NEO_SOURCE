
CREATE TABLE IF NOT EXISTS public.provisioning_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('workspace','worker')),
  organization_id uuid,
  subject_id uuid,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ready','failed')),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_step text,
  failure_reason text,
  attempts integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS provisioning_runs_key_idx
  ON public.provisioning_runs (kind, idempotency_key);

GRANT SELECT ON public.provisioning_runs TO authenticated;
GRANT ALL ON public.provisioning_runs TO service_role;
ALTER TABLE public.provisioning_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS provisioning_runs_admin_read ON public.provisioning_runs;
CREATE POLICY provisioning_runs_admin_read ON public.provisioning_runs
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());

CREATE OR REPLACE FUNCTION public.neo_provisioning_step(_run uuid, _step text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  UPDATE public.provisioning_runs
     SET steps = CASE WHEN steps ? _step THEN steps ELSE steps || to_jsonb(_step) END,
         current_step = _step,
         updated_at = now()
   WHERE id = _run;
$$;
REVOKE ALL ON FUNCTION public.neo_provisioning_step(uuid, text) FROM PUBLIC;

-- ------------------------------------------------------------------
-- Universal worker provisioning. One routine serves new workers, retries
-- and reassignment for every organisation; nothing is org- or person-specific.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_provision_worker(_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _caller uuid := auth.uid();
  _org uuid;
  _caller_name text;
  _run uuid;
  _key text := COALESCE(NULLIF(trim(_payload->>'idempotency_key'), ''),
                        'worker:' || lower(COALESCE(_payload->>'email','')) );
  _uid uuid := NULLIF(_payload->>'user_id','')::uuid;
  _branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  _dept uuid := NULLIF(_payload->>'department_id','')::uuid;
  _station uuid := NULLIF(_payload->>'station_id','')::uuid;
  _roles uuid[] := COALESCE((SELECT array_agg(value::uuid) FROM jsonb_array_elements_text(COALESCE(_payload->'role_ids','[]'::jsonb))), ARRAY[]::uuid[]);
  _primary uuid := NULLIF(_payload->>'primary_role_id','')::uuid;
  _staff_ref text;
  _restricted boolean;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_org_admin() THEN RAISE EXCEPTION 'Not permitted to provision workers'; END IF;
  IF _uid IS NULL THEN RAISE EXCEPTION 'An authentication account is required before provisioning'; END IF;

  SELECT organization_id, full_name INTO _org, _caller_name FROM public.profiles WHERE id = _caller;
  IF _org IS NULL THEN RAISE EXCEPTION 'Your account is not linked to an organisation'; END IF;

  -- Resumable ledger: retries reuse the same run instead of duplicating work.
  INSERT INTO public.provisioning_runs (kind, organization_id, subject_id, idempotency_key, payload, created_by)
  VALUES ('worker', _org, _uid, _key, _payload, _caller)
  ON CONFLICT (kind, idempotency_key) DO UPDATE
    SET attempts = public.provisioning_runs.attempts + 1,
        status = 'running',
        failure_reason = NULL,
        subject_id = EXCLUDED.subject_id,
        updated_at = now()
  RETURNING id INTO _run;

  -- Validation: every selected value must belong to this organisation.
  IF _branch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch AND organization_id = _org) THEN
    RAISE EXCEPTION 'The selected property does not belong to your organisation';
  END IF;
  IF _dept IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.departments WHERE id = _dept AND organization_id = _org) THEN
    RAISE EXCEPTION 'The selected department does not belong to your organisation';
  END IF;
  IF _station IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.operational_stations
     WHERE id = _station AND organization_id = _org
       AND (_branch IS NULL OR branch_id IS NULL OR branch_id = _branch)) THEN
    RAISE EXCEPTION 'The selected work area does not belong to the selected property';
  END IF;
  IF array_length(_roles,1) IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(_roles) r(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.roles ro
                        WHERE ro.id = r.id AND ro.organization_id = _org
                          AND ro.active AND COALESCE(ro.role_status,'active') <> 'archived')) THEN
    RAISE EXCEPTION 'One of the selected roles is not an active role in your organisation';
  END IF;

  -- Restricted business authority is never granted incidentally.
  SELECT EXISTS (
    SELECT 1 FROM public.roles ro
     WHERE ro.id = ANY(_roles)
       AND EXISTS (SELECT 1 FROM public.role_catalogue rc
                    WHERE rc.role_key = ro.normalized_role_key AND rc.restricted_authority)
  ) INTO _restricted;
  IF _restricted AND NOT public.can_approve_restricted() THEN
    RAISE EXCEPTION 'Only an authorised approver may grant a role that carries restricted authority';
  END IF;

  PERFORM public.neo_provisioning_step(_run, 'validated');

  _staff_ref := COALESCE(NULLIF(trim(_payload->>'staff_id'), ''),
                         'STF-' || upper(substr(replace(_uid::text,'-',''), 1, 6)));

  INSERT INTO public.profiles AS p (
    id, organization_id, account_type, full_name, staff_id, email, phone, job_title,
    branch_id, department_id, employment_status, account_status, invitation_status,
    must_change_password, created_by)
  VALUES (
    _uid, _org, 'staff',
    COALESCE(NULLIF(trim(_payload->>'full_name'), ''), 'New worker'),
    _staff_ref,
    COALESCE(NULLIF(trim(_payload->>'email'), ''), ''),
    COALESCE(_payload->>'phone', ''),
    COALESCE(NULLIF(trim(_payload->>'job_title'), ''), 'Staff'),
    _branch, _dept,
    COALESCE(NULLIF(_payload->>'employment_status',''), 'active'),
    COALESCE(NULLIF(_payload->>'account_status',''), 'active'),
    'active', true, _caller)
  ON CONFLICT (id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    full_name = EXCLUDED.full_name,
    phone = EXCLUDED.phone,
    job_title = EXCLUDED.job_title,
    branch_id = EXCLUDED.branch_id,
    department_id = EXCLUDED.department_id,
    employment_status = EXCLUDED.employment_status,
    account_status = EXCLUDED.account_status,
    updated_at = now()
  WHERE p.organization_id = _org OR p.organization_id IS NULL;

  PERFORM public.neo_provisioning_step(_run, 'profile');

  DELETE FROM public.user_roles WHERE user_id = _uid AND organization_id = _org;
  IF array_length(_roles,1) IS NOT NULL THEN
    INSERT INTO public.user_roles (organization_id, user_id, role_id, is_primary)
    SELECT _org, _uid, r.id,
           CASE WHEN _primary IS NOT NULL THEN r.id = _primary
                ELSE r.id = _roles[1] END
      FROM unnest(_roles) r(id)
    ON CONFLICT DO NOTHING;
  END IF;
  PERFORM public.neo_provisioning_step(_run, 'roles');

  DELETE FROM public.user_branches WHERE user_id = _uid AND organization_id = _org;
  IF _branch IS NOT NULL THEN
    INSERT INTO public.user_branches (organization_id, user_id, branch_id)
    VALUES (_org, _uid, _branch) ON CONFLICT DO NOTHING;
  END IF;

  DELETE FROM public.user_departments WHERE user_id = _uid AND organization_id = _org;
  IF _dept IS NOT NULL THEN
    INSERT INTO public.user_departments (organization_id, user_id, department_id)
    VALUES (_org, _uid, _dept) ON CONFLICT DO NOTHING;
  END IF;

  DELETE FROM public.user_stations WHERE user_id = _uid AND organization_id = _org;
  IF _station IS NOT NULL THEN
    INSERT INTO public.user_stations (organization_id, user_id, station_id, branch_id, is_primary, created_by)
    VALUES (_org, _uid, _station, _branch, true, _caller) ON CONFLICT DO NOTHING;
  END IF;
  PERFORM public.neo_provisioning_step(_run, 'assignments');

  INSERT INTO public.notification_preferences (organization_id, user_id)
  VALUES (_org, _uid) ON CONFLICT DO NOTHING;
  PERFORM public.neo_provisioning_step(_run, 'notifications');

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, _branch, _caller, COALESCE(_caller_name,''), 'worker.provisioned', 'administration', _uid,
          jsonb_build_object('roles', to_jsonb(_roles), 'primary_role_id', _primary,
                             'branch_id', _branch, 'department_id', _dept, 'station_id', _station));

  UPDATE public.provisioning_runs
     SET status = 'ready', current_step = 'ready', completed_at = now(), updated_at = now(),
         steps = CASE WHEN steps ? 'ready' THEN steps ELSE steps || to_jsonb('ready'::text) END
   WHERE id = _run;

  RETURN jsonb_build_object('status','ready','user_id',_uid,'staff_id',_staff_ref,'run_id',_run);
EXCEPTION WHEN OTHERS THEN
  IF _run IS NOT NULL THEN
    UPDATE public.provisioning_runs
       SET status = 'failed', failure_reason = SQLERRM, updated_at = now()
     WHERE id = _run;
  END IF;
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_provision_worker(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_provision_worker(jsonb) TO authenticated;
