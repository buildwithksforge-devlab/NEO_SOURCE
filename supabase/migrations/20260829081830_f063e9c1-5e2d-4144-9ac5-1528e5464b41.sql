CREATE OR REPLACE FUNCTION public.neo_finance_readiness()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _accounts int; _tax int; _years int; _periods int; _open int; _methods int;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('finance','view')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO _accounts FROM public.chart_of_accounts WHERE organization_id = _org;
  SELECT count(*) INTO _tax FROM public.tax_codes WHERE organization_id = _org;
  SELECT count(*) INTO _years FROM public.financial_years WHERE organization_id = _org;
  SELECT count(*) INTO _periods FROM public.accounting_periods WHERE organization_id = _org;
  SELECT count(*) INTO _open FROM public.accounting_periods
   WHERE organization_id = _org AND CURRENT_DATE BETWEEN starts_on AND ends_on
     AND COALESCE(status,'open') = 'open';

  -- Payment methods are configured as accounting mappings, not as a separate
  -- catalogue table; the earlier reference to public.payment_methods pointed at
  -- a table that has never existed and made this whole check fail.
  SELECT count(DISTINCT payment_method) INTO _methods
    FROM public.account_mappings
   WHERE organization_id = _org AND active AND payment_method IS NOT NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'accounts', _accounts,
    'tax_codes', _tax,
    'financial_years', _years,
    'periods', _periods,
    'current_period_open', _open > 0,
    'payment_methods', _methods,
    'ready', (_accounts > 0 AND _tax > 0 AND _years > 0 AND _periods > 0 AND _open > 0),
    'blocking', (
      SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
        SELECT 'chart_of_accounts' AS x WHERE _accounts = 0
        UNION ALL SELECT 'tax_codes' WHERE _tax = 0
        UNION ALL SELECT 'financial_year' WHERE _years = 0
        UNION ALL SELECT 'accounting_periods' WHERE _periods = 0
        UNION ALL SELECT 'open_period_today' WHERE _open = 0
        UNION ALL SELECT 'payment_methods' WHERE _methods = 0
      ) s
    ));
END $function$;

REVOKE ALL ON FUNCTION public.neo_finance_readiness() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_readiness() TO authenticated;