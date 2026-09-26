CREATE OR REPLACE FUNCTION public.neo_go_live_readiness(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _checks jsonb := '[]'::jsonb;
  _n int;
  _m int;
  _fin jsonb;
BEGIN
  IF _org IS NULL THEN
    RETURN jsonb_build_object('status', 'unknown', 'checks', '[]'::jsonb);
  END IF;

  -- POS configuration
  SELECT count(*) INTO _n
    FROM public.pos_settings ps
   WHERE ps.organization_id = _org
     AND (_branch IS NULL OR ps.branch_id IS NULL OR ps.branch_id = _branch);
  SELECT count(*) INTO _m
    FROM public.menu_items mi
   WHERE mi.organization_id = _org
     AND mi.publish_status = 'published'
     AND (_branch IS NULL OR mi.branch_id IS NULL OR mi.branch_id = _branch);
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'pos', 'domain', 'Point of Sale', 'label', 'POS configured',
    'status', CASE WHEN _n > 0 AND _m > 0 THEN 'ready' WHEN _m > 0 THEN 'attention' ELSE 'blocked' END,
    'detail', CASE WHEN _m = 0 THEN 'No published menu items for this property'
                   WHEN _n = 0 THEN 'POS settings not configured; defaults in use'
                   ELSE _m || ' published menu items' END,
    'count', _m, 'route', '/admin/configuration'));

  -- KDS routing
  SELECT count(*) INTO _n
    FROM public.pos_order_items oi
    JOIN public.pos_orders o ON o.id = oi.order_id
   WHERE o.organization_id = _org
     AND (_branch IS NULL OR o.branch_id = _branch)
     AND o.created_at > now() - interval '30 days'
     AND oi.station_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.station_tickets t
        WHERE t.order_id = o.id AND t.station_id = oi.station_id);
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'kds', 'domain', 'Kitchen', 'label', 'KDS routing',
    'status', CASE WHEN _n = 0 THEN 'ready' ELSE 'blocked' END,
    'detail', CASE WHEN _n = 0 THEN 'All kitchen-bound order lines have tickets'
                   ELSE _n || ' order lines have no kitchen ticket' END,
    'count', _n, 'route', '/kitchen/reconciliation'));

  -- Menu data completeness
  SELECT count(*) INTO _n FROM public.neo_menu_validation_states(_branch) v WHERE v.state <> 'ready';
  SELECT count(*) INTO _m FROM public.neo_menu_validation_states(_branch) v;
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'menu', 'domain', 'Menus', 'label', 'Menu master data complete',
    'status', CASE WHEN _m = 0 THEN 'blocked' WHEN _n = 0 THEN 'ready' ELSE 'attention' END,
    'detail', CASE WHEN _m = 0 THEN 'No menu items imported'
                   WHEN _n = 0 THEN _m || ' items fully mapped'
                   ELSE _n || ' of ' || _m || ' items need images, stations or recipes' END,
    'count', _n, 'route', '/pos/menu'));

  -- Housekeeping staffing
  SELECT count(*) INTO _n
    FROM public.employees e
    JOIN public.departments d ON d.id = e.department_id
   WHERE e.organization_id = _org
     AND e.employment_status = 'active'
     AND (_branch IS NULL OR e.branch_id = _branch)
     AND (d.catalogue_key = 'housekeeping' OR lower(d.name) LIKE '%housekeep%');
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'housekeeping', 'domain', 'Housekeeping', 'label', 'Housekeeping staff configured',
    'status', CASE WHEN _n >= 2 THEN 'ready' WHEN _n = 1 THEN 'attention' ELSE 'blocked' END,
    'detail', _n || ' active housekeeping employees',
    'count', _n, 'route', '/hr/employees'));

  -- Approvals
  SELECT count(*) INTO _n
    FROM public.approval_rules r
   WHERE r.organization_id = _org
     AND r.active
     AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch);
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'approvals', 'domain', 'Governance', 'label', 'Approval rules configured',
    'status', CASE WHEN _n > 0 THEN 'ready' ELSE 'blocked' END,
    'detail', CASE WHEN _n > 0 THEN _n || ' active approval rules' ELSE 'No approval authority defined' END,
    'count', _n, 'route', '/admin/approval-limits'));

  -- Finance readiness
  BEGIN
    _fin := public.neo_finance_readiness();
  EXCEPTION WHEN OTHERS THEN
    _fin := NULL;
  END;
  SELECT count(*) INTO _n
    FROM public.accounting_periods p
   WHERE p.organization_id = _org
     AND p.status = 'open'
     AND CURRENT_DATE BETWEEN p.starts_on AND p.ends_on;
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'finance', 'domain', 'Finance', 'label', 'Accounting period open',
    'status', CASE WHEN _n > 0 THEN 'ready' ELSE 'blocked' END,
    'detail', CASE WHEN _n > 0 THEN 'An accounting period is open for today'
                   ELSE 'No open accounting period covering today' END,
    'count', _n, 'route', '/finance', 'extra', COALESCE(_fin, '{}'::jsonb)));

  -- Rider identities
  SELECT count(*) INTO _n
    FROM public.rider_profiles rp
   WHERE rp.organization_id = _org
     AND rp.active
     AND (_branch IS NULL OR rp.branch_id = _branch)
     AND (rp.profile_id IS NULL OR rp.employee_id IS NULL);
  SELECT count(*) INTO _m
    FROM public.rider_profiles rp
   WHERE rp.organization_id = _org
     AND rp.active
     AND (_branch IS NULL OR rp.branch_id = _branch);
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'riders', 'domain', 'Delivery', 'label', 'Rider identities complete',
    'status', CASE WHEN _m = 0 THEN 'attention' WHEN _n = 0 THEN 'ready' ELSE 'blocked' END,
    'detail', CASE WHEN _m = 0 THEN 'No active riders for this property'
                   WHEN _n = 0 THEN _m || ' riders linked to staff records'
                   ELSE _n || ' riders missing a staff or login link' END,
    'count', _n, 'route', '/delivery/riders'));

  -- Event billing
  SELECT count(*) INTO _n
    FROM public.event_bookings b
   WHERE b.organization_id = _org
     AND (_branch IS NULL OR b.branch_id = _branch)
     AND b.status IN ('confirmed', 'completed')
     AND NOT EXISTS (SELECT 1 FROM public.event_billing_items i WHERE i.booking_id = b.id);
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'event_billing', 'domain', 'Events', 'label', 'Event billing complete',
    'status', CASE WHEN _n = 0 THEN 'ready' ELSE 'blocked' END,
    'detail', CASE WHEN _n = 0 THEN 'All confirmed events have billing lines'
                   ELSE _n || ' confirmed events have no charges' END,
    'count', _n, 'route', '/events/bookings'));

  RETURN jsonb_build_object(
    'branch_id', _branch,
    'generated_at', now(),
    'status', CASE
      WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(_checks) c WHERE c->>'status' = 'blocked') THEN 'blocked'
      WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(_checks) c WHERE c->>'status' = 'attention') THEN 'attention'
      ELSE 'ready' END,
    'checks', _checks);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_go_live_readiness(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_go_live_readiness(uuid) TO authenticated;