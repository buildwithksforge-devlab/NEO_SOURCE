CREATE OR REPLACE FUNCTION public.neo_assert_reporting_scope(_branch uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_scope text := public.current_access_scope();
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL OR NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'reporting_session_required' USING ERRCODE = '42501';
  END IF;
  IF _from IS NOT NULL AND _to IS NOT NULL AND _from > _to THEN
    RAISE EXCEPTION 'invalid_report_period' USING ERRCODE = '22007';
  END IF;
  IF _from IS NOT NULL AND _to IS NOT NULL AND (_to - _from) > 731 THEN
    RAISE EXCEPTION 'report_period_too_large' USING ERRCODE = '22023';
  END IF;
  -- Owner/Director ('organisation') and IT/System Administrator ('technical')
  -- are equal superusers: both may read organisation-wide figures with no
  -- explicit property selected.
  IF _branch IS NULL AND v_scope NOT IN ('organisation','technical') THEN
    RAISE EXCEPTION 'explicit_property_required_for_scoped_user' USING ERRCODE = '42501';
  END IF;
  IF _branch IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id = _branch AND b.organization_id = v_org AND public.neo_branch_in_scope(b.id)
  ) THEN
    RAISE EXCEPTION 'property_out_of_scope' USING ERRCODE = '42501';
  END IF;
END;
$function$;