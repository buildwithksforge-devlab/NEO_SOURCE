CREATE OR REPLACE FUNCTION public.neo_payment_register(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date, _state text DEFAULT NULL::text, _limit integer DEFAULT 500)
 RETURNS TABLE(id uuid, branch_id uuid, source_module text, source_record_id uuid, payment_table text, payment_id uuid, method text, provider_code text, environment text, amount numeric, currency text, tendered numeric, change_due numeric, reference text, state text, state_detail text, manual_tender boolean, verified_at timestamp with time zone, posted_journal_id uuid, requested_at timestamp with time zone, confirmed_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE = '42501'; END IF;
  IF NOT (public.is_org_admin_for(org) OR public.has_permission('finance','view')
          OR public.has_permission('finance','edit') OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT a.id, a.branch_id, a.source_module, a.source_record_id, a.payment_table, a.payment_id,
         a.method, a.provider_code, a.environment, a.amount, a.currency,
         a.tendered, a.change_due, a.reference, a.state, a.state_detail,
         a.manual_tender, a.verified_at, a.posted_journal_id, a.requested_at, a.confirmed_at
    FROM public.payment_attempts a
   WHERE a.organization_id = org
     AND (_branch IS NULL OR a.branch_id = _branch)
     AND (_from IS NULL OR a.requested_at >= _from::timestamptz)
     AND (_to IS NULL OR a.requested_at < (_to + 1)::timestamptz)
     AND (_state IS NULL OR a.state = _state)
   ORDER BY a.requested_at DESC
   LIMIT greatest(1, least(coalesce(_limit,500), 2000));
END;
$function$
