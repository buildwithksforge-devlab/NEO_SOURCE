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
    _org,
    _branch,
    _ref,
    'production',
    coalesce(nullif(trim(_module), ''), 'unspecified'),
    trim(_summary),
    nullif(trim(_steps), ''),
    nullif(trim(_expected), ''),
    nullif(trim(_actual), ''),
    _sev,
    CASE WHEN _sev IN ('high', 'critical') THEN 'high' ELSE 'normal' END,
    'new',
    _sev = 'critical',
    nullif(trim(_route), ''),
    auth.uid()
  )
  RETURNING id INTO _id;

  RETURN jsonb_build_object('id', _id, 'reference', _ref);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_report_defect(text, text, text, text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_report_defect(text, text, text, text, text, text, text, uuid) TO authenticated;