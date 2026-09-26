CREATE OR REPLACE FUNCTION public.neo_fact_supplement(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  tz text; today date; f date; t date; can_money boolean;
  lifecycle jsonb := '[]'::jsonb; blocked int := 0; oos int := 0;
  unmatched int := 0; unmatched_value numeric := 0; posted_n int := 0;
BEGIN
  PERFORM public.neo_assert_reporting_scope(_branch, _from, _to);
  IF org IS NULL THEN RETURN jsonb_build_object('authorised', false); END IF;
  can_money := public.is_org_admin() OR public.has_permission('finance','view')
    OR public.has_permission('analytics','view') OR public.has_permission('reports','view');

  tz := public.neo_fact_timezone(org, _branch);
  today := (now() AT TIME ZONE tz)::date;
  t := coalesce(_to, today); f := coalesce(_from, t - 29);

  SELECT count(*) FILTER (WHERE coalesce(r.status,'') IN ('maintenance','blocked','out_of_service')
                             OR r.out_of_order_from IS NOT NULL),
         count(*) FILTER (WHERE coalesce(r.status,'') = 'out_of_service')
    INTO blocked, oos
    FROM public.rooms r
   WHERE r.organization_id = org AND (_branch IS NULL OR r.branch_id = _branch);

  IF can_money THEN
    SELECT coalesce(jsonb_agg(x ORDER BY x->>'lifecycle'), '[]'::jsonb) INTO lifecycle
      FROM (
        SELECT jsonb_build_object('lifecycle', o.status, 'orders', count(*),
                                  'value', coalesce(sum(o.grand_total),0)) x
          FROM public.pos_orders o
         WHERE o.organization_id = org AND (_branch IS NULL OR o.branch_id = _branch)
           AND o.status IN ('draft','sent','ready','served','open','in-progress')
           AND (o.created_at AT TIME ZONE tz)::date BETWEEN f AND t
         GROUP BY o.status) s;

    -- Canonical truth: the Finance posting queue reads canonical_transaction_states,
    -- so intelligence counts exactly the same eligible-but-unposted rows. Any other
    -- definition (journal key matching) makes the two screens contradict each other.
    SELECT count(*), coalesce(sum(c.amount), 0) INTO unmatched, unmatched_value
      FROM public.canonical_transaction_states c
     WHERE c.organization_id = org
       AND (_branch IS NULL OR c.branch_id = _branch)
       AND c.occurred_at::date BETWEEN f AND t
       AND c.source_module IN ('pos','folio','laundry','events','delivery','inventory',
                               'supplier_invoice','supplier_payment','deposit','payment')
       AND c.financial_state = 'eligible';

    SELECT count(*) INTO posted_n FROM public.journal_entries j
     WHERE j.organization_id = org AND j.status = 'posted'
       AND (_branch IS NULL OR j.branch_id = _branch)
       AND j.accounting_date BETWEEN f AND t;
  END IF;

  RETURN jsonb_build_object(
    'authorised', true,
    'monetary_authorised', can_money,
    'period', jsonb_build_object('from', f, 'to', t),
    'pos_open_by_lifecycle', lifecycle,
    'rooms', jsonb_build_object('blocked_rooms', blocked, 'out_of_service_rooms', oos),
    'handoff', jsonb_build_object('unmatched_eligible', unmatched,
      'unmatched_eligible_value', unmatched_value, 'posted_journals', posted_n));
END $function$;

REVOKE ALL ON FUNCTION public.neo_fact_supplement(uuid,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_fact_supplement(uuid,date,date) TO authenticated, service_role;