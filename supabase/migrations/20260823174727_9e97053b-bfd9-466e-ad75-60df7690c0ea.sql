-- Events read models must obey the caller's property scope, not just the org.

CREATE OR REPLACE FUNCTION public.neo_event_workspace(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS TABLE(booking_id uuid, event_reference text, event_name text, status text, payment_status text, event_date date, start_at timestamp with time zone, end_at timestamp with time zone, setup_at timestamp with time zone, breakdown_at timestamp with time zone, branch_id uuid, branch_name text, venue_id uuid, venue_name text, customer_id uuid, customer_name text, corporate_account_id uuid, event_type_id uuid, event_type_name text, coordinator_id uuid, quotation_id uuid, quotation_number text, enquiry_id uuid, enquiry_number text, expected_guests integer, guaranteed_guests integer, final_guests integer, total_amount numeric, paid_amount numeric, balance_due numeric, deposit_required numeric, deposit_paid numeric, readiness_total integer, readiness_ready integer, readiness_blocked integer, billing_items integer, billing_total numeric, resource_reservations integer, feedback_responses integer, feedback_avg numeric, beo_status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_financial boolean := public.has_permission('events', 'billing', 'view');
  v_readiness boolean := public.has_permission('events', 'readiness', 'view');
  v_resources boolean := public.has_permission('events', 'resources', 'view');
  v_feedback boolean := public.has_permission('events', 'feedback', 'view');
BEGIN
  IF NOT public.has_permission('events', 'bookings', 'view') THEN
    RAISE EXCEPTION 'The events.bookings.view permission is required.' USING ERRCODE = '42501';
  END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    b.id, b.event_reference, b.event_name, b.status, b.payment_status,
    b.event_date, b.start_at, b.end_at, b.setup_at, b.breakdown_at,
    b.branch_id, br.name, b.venue_id, v.name,
    b.customer_id,
    nullif(trim(coalesce(c.full_name, '')), ''),
    b.corporate_account_id, b.event_type_id, et.name, b.coordinator_id,
    b.quotation_id, q.quotation_number, b.enquiry_id, e.enquiry_number,
    b.expected_guests, b.guaranteed_guests, b.final_guests,
    CASE WHEN v_financial THEN coalesce(b.total_amount, 0) END,
    CASE WHEN v_financial THEN coalesce(b.paid_amount, 0) END,
    CASE WHEN v_financial THEN coalesce(b.total_amount, 0) - coalesce(b.paid_amount, 0) END,
    CASE WHEN v_financial THEN coalesce(b.deposit_required, 0) END,
    CASE WHEN v_financial THEN coalesce(b.deposit_paid, 0) END,
    CASE WHEN v_readiness THEN rd.total::int END,
    CASE WHEN v_readiness THEN rd.ready::int END,
    CASE WHEN v_readiness THEN rd.blocked::int END,
    CASE WHEN v_financial THEN bl.items::int END,
    CASE WHEN v_financial THEN bl.amount END,
    CASE WHEN v_resources THEN rs.reservations::int END,
    CASE WHEN v_feedback THEN fb.responses::int END,
    CASE WHEN v_feedback THEN fb.avg_rating END,
    beo.status,
    b.created_at
  FROM public.event_bookings b
  LEFT JOIN public.branches br ON br.id = b.branch_id
  LEFT JOIN public.event_venues v ON v.id = b.venue_id
  LEFT JOIN public.customers c ON c.id = b.customer_id
  LEFT JOIN public.event_types et ON et.id = b.event_type_id
  LEFT JOIN public.event_quotations q ON q.id = b.quotation_id
  LEFT JOIN public.event_enquiries e ON e.id = b.enquiry_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS total,
           count(*) FILTER (WHERE r.readiness IN ('ready', 'completed')) AS ready,
           count(*) FILTER (WHERE r.readiness = 'blocked') AS blocked
    FROM public.event_department_requirements r WHERE r.booking_id = b.id
  ) rd ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS items, coalesce(sum(i.line_total), 0) AS amount
    FROM public.event_billing_items i WHERE i.booking_id = b.id
  ) bl ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS reservations
    FROM public.event_resource_reservations rr
    WHERE rr.booking_id = b.id AND coalesce(rr.status, '') <> 'released'
  ) rs ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS responses, round(avg(f.rating_overall)::numeric, 2) AS avg_rating
    FROM public.event_feedback f WHERE f.booking_id = b.id
  ) fb ON true
  LEFT JOIN LATERAL (
    SELECT o.status FROM public.banquet_event_orders o
    WHERE o.booking_id = b.id ORDER BY o.created_at DESC LIMIT 1
  ) beo ON true
  WHERE b.organization_id = public.current_org_id()
    AND public.neo_branch_in_scope(b.branch_id)
    AND (_branch IS NULL OR b.branch_id = _branch)
    AND (_from IS NULL OR b.event_date >= _from)
    AND (_to IS NULL OR b.event_date <= _to)
  ORDER BY b.event_date DESC, b.created_at DESC;
END
$function$;

-- The events dashboard must count the property the header is showing.
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
    'deposits_due', CASE WHEN v_fin THEN (SELECT COALESCE(SUM(GREATEST(deposit_required - deposit_paid,0)),0) FROM b_scoped WHERE status NOT IN ('cancelled','closed')) END,
    'outstanding', CASE WHEN v_fin THEN (SELECT COALESCE(SUM(GREATEST(total_amount - paid_amount,0)),0) FROM b_scoped WHERE status <> 'cancelled') END,
    'revenue_forecast', CASE WHEN v_fin THEN (SELECT COALESCE(SUM(total_amount),0) FROM b_scoped WHERE event_date >= current_date AND status <> 'cancelled') END,
    'guest_forecast', (SELECT COALESCE(SUM(COALESCE(final_guests, guaranteed_guests, expected_guests)),0) FROM b_scoped
                        WHERE event_date BETWEEN current_date AND current_date + 30 AND status <> 'cancelled'),
    'blocked_departments', (SELECT count(*) FROM event_department_requirements r JOIN b_scoped s ON s.id = r.booking_id WHERE r.readiness = 'blocked'),
    'venues', (SELECT count(*) FROM event_venues WHERE organization_id = v_org AND status = 'available'
                        AND public.neo_branch_in_scope(branch_id) AND (_branch IS NULL OR branch_id = _branch))
  )
  INTO v_out
  FROM (SELECT 1) _;
  RETURN v_out;
END
$function$;

-- Readiness must not leak departments from other properties.
CREATE OR REPLACE FUNCTION public.events_department_readiness(_booking uuid DEFAULT NULL::uuid)
 RETURNS TABLE(department_id uuid, department text, booking_id uuid, event_reference text, total bigint, ready bigint, blocked bigint, at_risk bigint, in_progress bigint, not_started bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT r.department_id,
         COALESCE(d.name, NULLIF(r.department_key,''), 'Unassigned') AS department,
         r.booking_id, b.event_reference,
         count(*) AS total,
         count(*) FILTER (WHERE r.readiness IN ('ready','completed')) AS ready,
         count(*) FILTER (WHERE r.readiness = 'blocked') AS blocked,
         count(*) FILTER (WHERE r.readiness = 'at-risk') AS at_risk,
         count(*) FILTER (WHERE r.readiness = 'in-progress') AS in_progress,
         count(*) FILTER (WHERE r.readiness = 'not-started') AS not_started
    FROM event_department_requirements r
    JOIN event_bookings b ON b.id = r.booking_id
    LEFT JOIN departments d ON d.id = r.department_id
   WHERE r.organization_id = current_org_id()
     AND public.has_permission('events', 'readiness', 'view')
     AND public.neo_branch_in_scope(b.branch_id)
     AND (_booking IS NULL OR r.booking_id = _booking)
   GROUP BY r.department_id, d.name, r.department_key, r.booking_id, b.event_reference
$function$;

-- An event can never be orphaned from a property.
ALTER TABLE public.event_bookings ALTER COLUMN branch_id SET NOT NULL;

REVOKE ALL ON FUNCTION public.neo_event_workspace(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.events_metrics(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.events_department_readiness(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_workspace(uuid, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.events_metrics(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.events_department_readiness(uuid) TO authenticated, service_role;