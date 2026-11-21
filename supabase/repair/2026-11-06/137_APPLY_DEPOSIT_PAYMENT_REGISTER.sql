BEGIN;
DO $guard$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.neo_payment_register(uuid,date,date,text,integer)'))) IS DISTINCT FROM 'd8477118345ae40e1a93c3617058cafe' THEN RAISE EXCEPTION 'Payment register definition differs; inspect before installation'; END IF; END $guard$;
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

  IF _branch IS NOT NULL AND NOT coalesce(public.neo_branch_in_scope(_branch),false) THEN RAISE EXCEPTION 'Property outside your access' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.reservation_deposits d WHERE d.organization_id=org AND coalesce(public.neo_branch_in_scope(d.branch_id),false) AND (_branch IS NULL OR d.branch_id=_branch) AND (_from IS NULL OR (coalesce(d.received_at,d.created_at) AT TIME ZONE public.neo_fact_timezone(org,d.branch_id))::date>=_from) AND (_to IS NULL OR (coalesce(d.received_at,d.created_at) AT TIME ZONE public.neo_fact_timezone(org,d.branch_id))::date<=_to) AND (d.amount IS NULL OR d.amount<=0 OR d.amount::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'A reservation deposit amount is incomplete or non-finite; review its source before using the register'; END IF;
  IF EXISTS(SELECT 1 FROM public.reservation_deposits d JOIN public.payment_attempts a ON a.organization_id=d.organization_id AND a.payment_table='payments' AND a.payment_id=d.payment_id AND a.branch_id IS NOT DISTINCT FROM d.branch_id WHERE d.organization_id=org AND coalesce(public.neo_branch_in_scope(d.branch_id),false) AND (_branch IS NULL OR d.branch_id=_branch) AND (_from IS NULL OR (coalesce(d.received_at,d.created_at) AT TIME ZONE public.neo_fact_timezone(org,d.branch_id))::date>=_from) AND (_to IS NULL OR (coalesce(d.received_at,d.created_at) AT TIME ZONE public.neo_fact_timezone(org,d.branch_id))::date<=_to) AND (a.amount IS DISTINCT FROM d.amount OR a.currency IS DISTINCT FROM d.currency)) THEN RAISE EXCEPTION 'A deposit and its linked payment disagree in amount or currency; review the reservation before using these totals'; END IF;
  RETURN QUERY
  WITH deposit_rows AS (
    SELECT d.id,d.branch_id,'deposit'::text AS source_module,d.reservation_id AS source_record_id,
      'reservation_deposits'::text AS payment_table,d.id AS payment_id,d.method,NULL::text AS provider_code,NULL::text AS environment,
      d.amount,d.currency,NULL::numeric AS tendered,NULL::numeric AS change_due,d.reference,
      CASE WHEN d.status IN ('held','applied','forfeited') THEN 'confirmed' WHEN d.status='refunded' THEN 'refunded' WHEN d.status IN ('cancelled','voided') THEN 'cancelled' ELSE 'requested' END::text AS state,
      CASE WHEN d.status='applied' THEN 'Deposit already received; applied to the guest folio. Application is not a second collection.' ELSE 'Reservation deposit recorded at source; held separately from revenue.' END::text AS state_detail,
      true AS manual_tender,
      verified.verified_at,NULL::uuid AS posted_journal_id,
      coalesce(d.received_at,d.created_at) AS requested_at,
      CASE WHEN d.status IN ('held','applied','forfeited','refunded') THEN coalesce(d.received_at,d.created_at) END AS confirmed_at
    FROM public.reservation_deposits d
    LEFT JOIN LATERAL (SELECT max(a.verified_at) AS verified_at FROM public.payment_attempts a WHERE a.organization_id=d.organization_id AND a.branch_id IS NOT DISTINCT FROM d.branch_id AND a.amount=d.amount AND a.currency IS NOT DISTINCT FROM d.currency AND ((a.payment_table='payments' AND a.payment_id=d.payment_id) OR (a.payment_table='reservation_deposits' AND a.payment_id=d.id))) verified ON true
    WHERE d.organization_id=org AND coalesce(public.neo_branch_in_scope(d.branch_id),false)
      AND (_branch IS NULL OR d.branch_id=_branch)
  ), attempt_rows AS (
    SELECT a.id,a.branch_id,a.source_module,a.source_record_id,a.payment_table,a.payment_id,a.method,a.provider_code,a.environment,a.amount,a.currency,a.tendered,a.change_due,a.reference,a.state,a.state_detail,a.manual_tender,a.verified_at,a.posted_journal_id,a.requested_at,a.confirmed_at
    FROM public.payment_attempts a
    WHERE a.organization_id=org AND coalesce(public.neo_branch_in_scope(a.branch_id),false)
      AND (_branch IS NULL OR a.branch_id=_branch)
      AND NOT EXISTS(SELECT 1 FROM public.reservation_deposits d WHERE d.organization_id=a.organization_id AND d.branch_id IS NOT DISTINCT FROM a.branch_id AND d.amount=a.amount AND d.currency IS NOT DISTINCT FROM a.currency AND ((a.payment_table='payments' AND a.payment_id=d.payment_id) OR (a.payment_table='reservation_deposits' AND a.payment_id=d.id)))
      AND NOT EXISTS(SELECT 1 FROM public.event_payments e JOIN public.payment_attempts canonical ON canonical.payment_table='payments' AND canonical.payment_id=e.payment_id AND canonical.organization_id=e.organization_id AND canonical.branch_id IS NOT DISTINCT FROM e.branch_id AND canonical.amount=e.amount AND canonical.currency IS NOT DISTINCT FROM e.currency AND canonical.state IN ('confirmed','posted') WHERE a.payment_table='event_payments' AND a.payment_id=e.id AND a.organization_id=e.organization_id AND a.branch_id IS NOT DISTINCT FROM e.branch_id AND e.entry_type IN ('payment','deposit'))
  ), combined AS (SELECT * FROM attempt_rows UNION ALL SELECT * FROM deposit_rows)
  SELECT c.* FROM combined c
   WHERE (_from IS NULL OR (c.requested_at AT TIME ZONE public.neo_fact_timezone(org,c.branch_id))::date>=_from)
     AND (_to IS NULL OR (c.requested_at AT TIME ZONE public.neo_fact_timezone(org,c.branch_id))::date<=_to)
     AND (_state IS NULL OR c.state=_state)
   ORDER BY c.requested_at DESC,c.id
   LIMIT greatest(1,least(coalesce(_limit,500),2000));
END;
$function$
;
COMMIT;
