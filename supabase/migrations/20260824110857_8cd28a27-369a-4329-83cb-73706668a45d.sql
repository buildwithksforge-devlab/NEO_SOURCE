CREATE OR REPLACE FUNCTION public.neo_hr_reconcile_staff(_commit boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := current_org_id();
  _pending int := 0;
  _created int := 0;
  _linked int := 0;
  _sample jsonb;
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No organisation context';
  END IF;

  IF NOT has_permission('hr-employees', 'create') THEN
    RAISE EXCEPTION 'Not authorised to reconcile the HR directory';
  END IF;

  -- Staff accounts that hold at least one role but have no HR record yet.
  CREATE TEMP TABLE _hr_recon ON COMMIT DROP AS
  SELECT p.id AS profile_id,
         p.full_name,
         p.staff_id,
         p.email,
         p.phone,
         p.avatar_url,
         p.branch_id,
         p.department_id,
         p.job_title,
         p.employment_status
  FROM public.profiles p
  WHERE p.organization_id = _org
    AND p.account_type IS DISTINCT FROM 'guest'
    AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.organization_id = _org)
    AND NOT EXISTS (
      SELECT 1 FROM public.employees e
      WHERE e.organization_id = _org AND e.profile_id = p.id
    );

  SELECT count(*) INTO _pending FROM _hr_recon;

  SELECT jsonb_agg(jsonb_build_object('name', full_name, 'staff_id', staff_id, 'job_title', job_title))
    INTO _sample
  FROM (SELECT full_name, staff_id, job_title FROM _hr_recon ORDER BY full_name LIMIT 10) s;

  IF _commit AND _pending > 0 THEN
    -- Link first: an existing employee row matched by staff number keeps its history.
    WITH matched AS (
      SELECT e.id AS employee_id, r.profile_id
      FROM public.employees e
      JOIN _hr_recon r
        ON r.staff_id IS NOT NULL
       AND e.employee_number = r.staff_id
      WHERE e.organization_id = _org AND e.profile_id IS NULL
    ), upd AS (
      UPDATE public.employees e
         SET profile_id = m.profile_id, updated_at = now()
        FROM matched m
       WHERE e.id = m.employee_id
      RETURNING 1
    )
    SELECT count(*) INTO _linked FROM upd;

    DELETE FROM _hr_recon r
     WHERE EXISTS (SELECT 1 FROM public.employees e
                    WHERE e.organization_id = _org AND e.profile_id = r.profile_id);

    WITH ins AS (
      INSERT INTO public.employees (
        organization_id, profile_id, employee_number, full_name,
        avatar_url, phone, work_email, branch_id, department_id, job_title,
        employment_status, payroll_status, system_access_status, notes, created_by
      )
      SELECT _org,
             r.profile_id,
             COALESCE(NULLIF(r.staff_id, ''), 'STF-R-' || upper(substr(replace(r.profile_id::text, '-', ''), 1, 8))),
             r.full_name,
             r.avatar_url,
             COALESCE(r.phone, ''),
             COALESCE(r.email, ''),
             r.branch_id,
             r.department_id,
             COALESCE(NULLIF(r.job_title, ''), ''),
             CASE WHEN r.employment_status IN ('active','probation','suspended','terminated','resigned','exited')
                  THEN r.employment_status ELSE 'active' END,
             'not_ready',
             'active',
             'Reconciled from the staff account on ' || to_char(now(), 'YYYY-MM-DD') ||
               '. Employment dates, contract, grade and reporting line are not set and must be completed by HR.',
             auth.uid()
      FROM _hr_recon r
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO _created FROM ins;
  END IF;

  RETURN jsonb_build_object(
    'committed', _commit,
    'pending', _pending,
    'created', _created,
    'linked', _linked,
    'sample', COALESCE(_sample, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.neo_hr_reconcile_staff(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_hr_reconcile_staff(boolean) TO authenticated;