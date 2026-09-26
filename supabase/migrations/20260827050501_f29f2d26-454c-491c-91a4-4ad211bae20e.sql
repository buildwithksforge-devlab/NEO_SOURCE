-- Track B — notification visibility + report-a-bug routing.
DROP POLICY IF EXISTS "notifications read" ON public.notifications;
CREATE POLICY "notifications read" ON public.notifications FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      user_id = auth.uid()
      OR acted_by = auth.uid()
      OR (
        user_id IS NULL
        AND public.in_my_scope(
          organization_id, branch_id, department_id, station_id, NULL::uuid, NULL::uuid
        )
      )
    )
  );

DROP POLICY IF EXISTS "notifications update" ON public.notifications;
CREATE POLICY "notifications update" ON public.notifications FOR UPDATE TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      user_id = auth.uid()
      OR (
        user_id IS NULL
        AND public.in_my_scope(
          organization_id, branch_id, department_id, station_id, NULL::uuid, NULL::uuid
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION public.neo_report_defect(
  _module text,
  _summary text,
  _actual text DEFAULT NULL,
  _expected text DEFAULT NULL,
  _steps text DEFAULT NULL,
  _severity text DEFAULT 'medium',
  _route text DEFAULT NULL,
  _branch uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := current_org_id();
  _ref text;
  _id uuid;
  _sev text := lower(coalesce(nullif(trim(_severity), ''), 'medium'));
  _reporter text;
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No organisation in scope for this account';
  END IF;
  IF coalesce(trim(_summary), '') = '' THEN
    RAISE EXCEPTION 'Describe the problem before submitting';
  END IF;
  IF _sev NOT IN ('low', 'medium', 'high', 'critical') THEN
    _sev := 'medium';
  END IF;

  SELECT 'DEF-' || to_char(now(), 'YYYY') || '-' ||
         lpad((count(*) + 1)::text, 4, '0')
    INTO _ref
    FROM public.defects
   WHERE organization_id = _org
     AND created_at >= date_trunc('year', now());

  INSERT INTO public.defects (
    organization_id, branch_id, reference, environment, module, summary,
    steps_to_reproduce, expected_result, actual_result, severity, priority,
    status, release_blocking, evidence_reference, reported_by
  ) VALUES (
    _org, _branch, _ref, 'production',
    coalesce(nullif(trim(_module), ''), 'unspecified'),
    trim(_summary),
    nullif(trim(_steps), ''),
    nullif(trim(_expected), ''),
    nullif(trim(_actual), ''),
    _sev,
    CASE WHEN _sev IN ('high', 'critical') THEN 'high' ELSE 'normal' END,
    'new', _sev = 'critical', nullif(trim(_route), ''), auth.uid()
  )
  RETURNING id INTO _id;

  SELECT coalesce(nullif(trim(p.full_name), ''), p.email, 'A worker')
    INTO _reporter
    FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.notifications (
    organization_id, branch_id, user_id, category, title, body, link,
    priority, action_required, status, source_module, source_record_id,
    event_type, idempotency_key
  )
  SELECT DISTINCT
    _org, _branch, ur.user_id, 'system-alert',
    'Bug reported: ' || _ref,
    coalesce(_reporter, 'A worker') || ' reported a problem on ' ||
      coalesce(nullif(trim(_route), ''), coalesce(nullif(trim(_module), ''), 'the workspace')) ||
      ' (' || _sev || '). ' || trim(_summary),
    '/platform/quality',
    CASE WHEN _sev IN ('high', 'critical') THEN 'high' ELSE 'normal' END,
    true, 'open', 'quality', _id, 'quality.defect_reported',
    'defect:' || _id::text || ':' || ur.user_id::text
  FROM public.user_roles ur
  JOIN public.roles r ON r.id = ur.role_id
  WHERE ur.organization_id = _org
    AND r.organization_id = _org
    AND r.role_status <> 'archived'
    AND (
      r.normalized_role_key IN ('owner', 'it-system-administrator')
      OR r.name IN ('Owner', 'System Administrator', 'IT/System Administrator',
                    'Owner / Director / Super User')
    )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('id', _id, 'reference', _ref);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_report_defect(text, text, text, text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_report_defect(text, text, text, text, text, text, text, uuid) TO authenticated;