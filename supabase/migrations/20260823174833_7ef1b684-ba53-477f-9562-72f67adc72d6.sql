CREATE OR REPLACE FUNCTION public.events_metrics(_branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid := public.current_org_id(); v_fin boolean; v_out jsonb;
BEGIN
  IF v_org IS NULL THEN RETURN '{}'::jsonb; END IF;
  IF NOT public.has_permission('events', 'bookings', 'view') THEN
    RAISE EXCEPTION 'The events.bookings.view permission is required.' USING ERRCODE = '42501';
  END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  v_fin := public.has_permission('events', 'billing', 'view');

  WITH b_scoped AS (
    SELECT * FROM public.event_bookings
     WHERE organization_id = v_org
       AND public.neo_branch_in_scope(branch_id)
       AND (_branch IS NULL OR branch_id = _branch)
  )
  SELECT jsonb_build_object(
    'new_enquiries', (SELECT count(*) FROM event_enquiries WHERE organization_id = v_org AND status = 'new'
                        AND public.neo_branch_in_scope(branch_id) AND (_branch IS NULL OR branch_id = _branch)),
    'followups_due', (SELECT count(*) FROM event_enquiries WHERE organization_id = v_org AND next_followup_at < now()
                        AND status NOT IN ('converted','lost','cancelled','archived')
                        AND public.neo_branch_in_scope(branch_id) AND (_branch IS NULL OR branch_id = _branch)),
    'site_visits_pending', (SELECT count(*) FROM site_visits WHERE organization_id = v_org AND status IN ('scheduled','confirmed')
                        AND public.neo_branch_in_scope(branch_id) AND (_branch IS NULL OR branch_id = _branch)),
    'quotations_pending', (SELECT count(*) FROM event_quotations WHERE organization_id = v_org AND status IN ('draft','pending-approval','sent','viewed')
                        AND public.neo_branch_in_scope(branch_id) AND (_branch IS NULL OR branch_id = _branch)),
    'quotations_accepted', (SELECT count(*) FROM event_quotations WHERE organization_id = v_org AND status IN ('accepted','converted')
                        AND public.neo_branch_in_scope(branch_id) AND (_branch IS NULL OR branch_id = _branch)),
    'quotations_total', (SELECT count(*) FROM event_quotations WHERE organization_id = v_org
                        AND public.neo_branch_in_scope(branch_id) AND (_branch IS NULL OR branch_id = _branch)),
    'provisional', (SELECT count(*) FROM b_scoped WHERE status IN ('provisional-hold','awaiting-deposit','awaiting-credit-approval')),
    'confirmed', (SELECT count(*) FROM b_scoped WHERE status IN ('confirmed','in-planning','ready')),
    'events_today', (SELECT count(*) FROM b_scoped WHERE event_date = current_date AND status <> 'cancelled'),
    'upcoming_30d', (SELECT count(*) FROM b_scoped WHERE event_date BETWEEN current_date AND current_date + 30 AND status <> 'cancelled'),
    'deposits_due', CASE WHEN v_fin THEN (SELECT COALESCE(SUM(GREATEST(coalesce(deposit_required,0) - coalesce(deposit_paid,0),0)),0) FROM b_scoped WHERE status NOT IN ('cancelled','closed')) END,
    'outstanding', CASE WHEN v_fin THEN (SELECT COALESCE(SUM(GREATEST(coalesce(total_amount,0) - coalesce(paid_amount,0),0)),0) FROM b_scoped WHERE status <> 'cancelled') END,
    'revenue_forecast', CASE WHEN v_fin THEN (SELECT COALESCE(SUM(coalesce(total_amount,0)),0) FROM b_scoped WHERE event_date >= current_date AND status <> 'cancelled') END,
    'guest_forecast', (SELECT COALESCE(SUM(COALESCE(final_guests, guaranteed_guests, expected_guests)),0) FROM b_scoped
                        WHERE event_date BETWEEN current_date AND current_date + 30 AND status <> 'cancelled'),
    'blocked_departments', (SELECT count(*) FROM event_department_requirements r JOIN b_scoped s ON s.id = r.booking_id WHERE r.readiness = 'blocked'),
    'venues', (SELECT count(*) FROM event_venues WHERE organization_id = v_org AND status = 'available'
                        AND public.neo_branch_in_scope(branch_id) AND (_branch IS NULL OR branch_id = _branch))
  )
  INTO v_out;
  RETURN v_out;
END
$function$;

REVOKE ALL ON FUNCTION public.events_metrics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.events_metrics(uuid) TO authenticated, service_role;