CREATE OR REPLACE FUNCTION public.neo_assert_reporting_scope(_branch uuid, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
  IF _branch IS NULL AND v_scope NOT IN ('organisation') THEN
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
REVOKE ALL ON FUNCTION public.neo_assert_reporting_scope(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_assert_reporting_scope(uuid, date, date) TO authenticated, service_role;

DO $block$
DECLARE
  r record;
  ddl text;
  needle text;
  injected text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('bi_kpis','bi_revenue_series','bi_revenue_breakdown','bi_occupancy_series','neo_facts','neo_intelligence','neo_fact_reconciliation','neo_fact_supplement','neo_unmatched_facts','neo_reconciliation_meta')
      AND pg_get_function_identity_arguments(p.oid) LIKE '%_branch uuid%'
      AND pg_get_function_identity_arguments(p.oid) LIKE '%_from date%'
      AND pg_get_function_identity_arguments(p.oid) LIKE '%_to date%'
  LOOP
    ddl := pg_get_functiondef(r.oid);
    IF position('neo_assert_reporting_scope' IN ddl) = 0 THEN
      needle := E'BEGIN\n';
      injected := E'BEGIN\n  PERFORM public.neo_assert_reporting_scope(_branch, _from, _to);\n';
      ddl := regexp_replace(ddl, needle, injected, 1, 1);
      EXECUTE ddl;
    END IF;
  END LOOP;

  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('bi_data_quality_scan','bi_risk_scan','neo_operational_facts','neo_front_office_facts')
      AND pg_get_function_identity_arguments(p.oid) LIKE '%_branch uuid%'
  LOOP
    ddl := pg_get_functiondef(r.oid);
    IF position('neo_assert_reporting_scope' IN ddl) = 0 THEN
      needle := E'BEGIN\n';
      injected := E'BEGIN\n  PERFORM public.neo_assert_reporting_scope(_branch, NULL, NULL);\n';
      ddl := regexp_replace(ddl, needle, injected, 1, 1);
      EXECUTE ddl;
    END IF;
  END LOOP;
END;
$block$;

DO $block$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'bi_kpis','bi_revenue_series','bi_revenue_breakdown','bi_occupancy_series',
      'bi_data_quality_scan','bi_risk_scan','neo_facts','neo_intelligence',
      'neo_fact_reconciliation','neo_fact_supplement','neo_unmatched_facts',
      'neo_reconciliation_meta','neo_operational_facts','neo_front_office_facts'
    )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.signature);
  END LOOP;
END;
$block$;