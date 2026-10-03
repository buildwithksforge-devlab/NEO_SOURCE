-- NEO-ADM-002
-- Remove service-role dependency from Add User while preserving the current
-- production worker-provisioning behaviour.

CREATE OR REPLACE FUNCTION public.neo_provision_worker(_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _org uuid;
  _caller_name text;
  _run uuid;

  _key text := COALESCE(
    NULLIF(trim(_payload->>'idempotency_key'), ''),
    'worker:' || lower(COALESCE(_payload->>'email',''))
  );

  _uid uuid := NULLIF(_payload->>'user_id','')::uuid;
  _branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  _dept uuid := NULLIF(_payload->>'department_id','')::uuid;
  _station uuid := NULLIF(_payload->>'station_id','')::uuid;

  _roles uuid[] := COALESCE(
    (
      SELECT array_agg(value::uuid)
      FROM jsonb_array_elements_text(
        COALESCE(_payload->'role_ids','[]'::jsonb)
      )
    ),
    ARRAY[]::uuid[]
  );

  _primary uuid := NULLIF(_payload->>'primary_role_id','')::uuid;

  -- NEW: reporting line comes through the same authoritative provisioning RPC.
  _manager uuid := NULLIF(_payload->>'reporting_manager_profile_id','')::uuid;

  _staff_ref text;
  _restricted boolean;

  _manager_required boolean := false;
  _review_required boolean := false;
  _review_reason text := '';
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Preserve current production authority logic.
  IF NOT public.can_manage_workforce() THEN
    RAISE EXCEPTION 'Not permitted to provision workers';
  END IF;

  IF _uid IS NULL THEN
    RAISE EXCEPTION 'An authentication account is required before provisioning';
  END IF;

  SELECT organization_id, full_name
    INTO _org, _caller_name
    FROM public.profiles
   WHERE id = _caller;

  IF _org IS NULL THEN
    RAISE EXCEPTION 'Your account is not linked to an organisation';
  END IF;

  INSERT INTO public.provisioning_runs (
    kind,
    organization_id,
    subject_id,
    idempotency_key,
    payload,
    created_by
  )
  VALUES (
    'worker',
    _org,
    _uid,
    _key,
    _payload,
    _caller
  )
  ON CONFLICT (kind, idempotency_key)
  DO UPDATE SET
    attempts = public.provisioning_runs.attempts + 1,
    status = 'running',
    failure_reason = NULL,
    subject_id = EXCLUDED.subject_id,
    updated_at = now()
  RETURNING id INTO _run;

  -- Property validation.
  IF _branch IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.branches
        WHERE id = _branch
          AND organization_id = _org
     )
  THEN
    RAISE EXCEPTION 'The selected property does not belong to your organisation';
  END IF;

  -- Department validation.
  IF _dept IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.departments
        WHERE id = _dept
          AND organization_id = _org
     )
  THEN
    RAISE EXCEPTION 'The selected department does not belong to your organisation';
  END IF;

  -- Station validation.
  IF _station IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.operational_stations
        WHERE id = _station
          AND organization_id = _org
          AND (
            _branch IS NULL
            OR branch_id IS NULL
            OR branch_id = _branch
          )
     )
  THEN
    RAISE EXCEPTION 'The selected work area does not belong to the selected property';
  END IF;

  -- Role validation.
  IF array_length(_roles,1) IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM unnest(_roles) r(id)
        WHERE NOT EXISTS (
          SELECT 1
            FROM public.roles ro
           WHERE ro.id = r.id
             AND ro.organization_id = _org
             AND ro.active
             AND COALESCE(ro.role_status,'active') <> 'archived'
        )
     )
  THEN
    RAISE EXCEPTION 'One of the selected roles is not an active role in your organisation';
  END IF;

  -- Restricted authority protection.
  SELECT EXISTS (
    SELECT 1
      FROM public.roles ro
     WHERE ro.id = ANY(_roles)
       AND EXISTS (
         SELECT 1
           FROM public.role_catalogue rc
          WHERE rc.role_key = ro.normalized_role_key
            AND rc.restricted_authority
       )
  )
  INTO _restricted;

  IF _restricted AND NOT public.can_approve_restricted() THEN
    RAISE EXCEPTION
      'Only an authorised approver may grant a role that carries restricted authority';
  END IF;

  PERFORM public.neo_provisioning_step(_run, 'validated');

  -- Preserve current production staff-ID allocator.
  _staff_ref := COALESCE(
    NULLIF(trim(_payload->>'staff_id'), ''),
    public.neo_allocate_staff_id(_org)
  );

  INSERT INTO public.profiles AS p (
    id,
    organization_id,
    account_type,
    full_name,
    staff_id,
    email,
    phone,
    job_title,
    branch_id,
    department_id,
    employment_status,
    account_status,
    invitation_status,
    must_change_password,
    created_by
  )
  VALUES (
    _uid,
    _org,
    'staff',
    COALESCE(NULLIF(trim(_payload->>'full_name'), ''), 'New worker'),
    _staff_ref,
    COALESCE(NULLIF(trim(_payload->>'email'), ''), ''),
    COALESCE(_payload->>'phone', ''),
    COALESCE(NULLIF(trim(_payload->>'job_title'), ''), 'Staff'),
    _branch,
    _dept,
    COALESCE(NULLIF(_payload->>'employment_status',''), 'active'),
    COALESCE(NULLIF(_payload->>'account_status',''), 'active'),
    'active',
    true,
    _caller
  )
  ON CONFLICT (id)
  DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    full_name = EXCLUDED.full_name,
    phone = EXCLUDED.phone,
    job_title = EXCLUDED.job_title,
    branch_id = EXCLUDED.branch_id,
    department_id = EXCLUDED.department_id,
    employment_status = EXCLUDED.employment_status,
    account_status = EXCLUDED.account_status,
    updated_at = now()
  WHERE p.organization_id = _org
     OR p.organization_id IS NULL;

  PERFORM public.neo_provisioning_step(_run, 'profile');

  DELETE FROM public.user_roles
   WHERE user_id = _uid
     AND organization_id = _org;

  IF array_length(_roles,1) IS NOT NULL THEN
    INSERT INTO public.user_roles (
      organization_id,
      user_id,
      role_id,
      is_primary
    )
    SELECT
      _org,
      _uid,
      r.id,
      CASE
        WHEN _primary IS NOT NULL THEN r.id = _primary
        ELSE r.id = _roles[1]
      END
    FROM unnest(_roles) r(id)
    ON CONFLICT DO NOTHING;
  END IF;

  PERFORM public.neo_provisioning_step(_run, 'roles');

  DELETE FROM public.user_branches
   WHERE user_id = _uid
     AND organization_id = _org;

  IF _branch IS NOT NULL THEN
    INSERT INTO public.user_branches (
      organization_id,
      user_id,
      branch_id
    )
    VALUES (_org, _uid, _branch)
    ON CONFLICT DO NOTHING;
  END IF;

  DELETE FROM public.user_departments
   WHERE user_id = _uid
     AND organization_id = _org;

  IF _dept IS NOT NULL THEN
    INSERT INTO public.user_departments (
      organization_id,
      user_id,
      department_id
    )
    VALUES (_org, _uid, _dept)
    ON CONFLICT DO NOTHING;
  END IF;

  DELETE FROM public.user_stations
   WHERE user_id = _uid
     AND organization_id = _org;

  IF _station IS NOT NULL THEN
    INSERT INTO public.user_stations (
      organization_id,
      user_id,
      station_id,
      branch_id,
      is_primary,
      created_by
    )
    VALUES (
      _org,
      _uid,
      _station,
      _branch,
      true,
      _caller
    )
    ON CONFLICT DO NOTHING;
  END IF;

  PERFORM public.neo_provisioning_step(_run, 'assignments');

  -- -----------------------------------------------------------
  -- Reporting manager
  -- -----------------------------------------------------------

  IF _manager IS NOT NULL THEN
    IF _manager = _uid THEN
      RAISE EXCEPTION 'An employee cannot report to themselves';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.neo_reporting_candidates(
          _uid,
          _branch,
          _dept,
          _station,
          _roles
        ) candidate
       WHERE candidate.profile_id = _manager
    )
    THEN
      RAISE EXCEPTION
        'That manager is not eligible for this employee''s roles, department or property';
    END IF;

  ELSE
    SELECT COALESCE(bool_or(meta.manager_required), false)
      INTO _manager_required
      FROM public.neo_role_reporting_meta(_roles) meta;

    IF _manager_required THEN
      _review_required := true;
      _review_reason :=
        'No reporting manager recorded — confirm the reporting line.';
    END IF;
  END IF;

  UPDATE public.profiles
     SET reporting_manager_id = _manager,
         reporting_effective_from =
           CASE
             WHEN _manager IS NULL THEN NULL
             ELSE CURRENT_DATE
           END,
         assignment_review_required = _review_required,
         assignment_review_reason = _review_reason
   WHERE id = _uid
     AND organization_id = _org;

  PERFORM public.neo_provisioning_step(_run, 'reporting');

  INSERT INTO public.notification_preferences (
    organization_id,
    user_id
  )
  VALUES (_org, _uid)
  ON CONFLICT DO NOTHING;

  PERFORM public.neo_provisioning_step(_run, 'notifications');

  INSERT INTO public.audit_logs (
    organization_id,
    branch_id,
    user_id,
    user_name,
    action,
    module,
    record_id,
    new_value
  )
  VALUES (
    _org,
    _branch,
    _caller,
    COALESCE(_caller_name,''),
    'worker.provisioned',
    'administration',
    _uid,
    jsonb_build_object(
      'roles', to_jsonb(_roles),
      'primary_role_id', _primary,
      'branch_id', _branch,
      'department_id', _dept,
      'station_id', _station,
      'reporting_manager_id', _manager
    )
  );

  UPDATE public.provisioning_runs
     SET status = 'ready',
         current_step = 'ready',
         completed_at = now(),
         updated_at = now(),
         steps = CASE
           WHEN steps ? 'ready'
             THEN steps
           ELSE steps || to_jsonb('ready'::text)
         END
   WHERE id = _run;

  RETURN jsonb_build_object(
    'status','ready',
    'user_id',_uid,
    'staff_id',_staff_ref,
    'run_id',_run
  );

EXCEPTION WHEN OTHERS THEN
  IF _run IS NOT NULL THEN
    UPDATE public.provisioning_runs
       SET status = 'failed',
           failure_reason = SQLERRM,
           updated_at = now()
     WHERE id = _run;
  END IF;

  RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_provision_worker(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_provision_worker(jsonb) TO authenticated;
