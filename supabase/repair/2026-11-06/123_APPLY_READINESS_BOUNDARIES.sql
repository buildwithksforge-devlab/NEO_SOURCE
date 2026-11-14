BEGIN;
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.neo_go_live_readiness(uuid)'::regprocedure)) IS DISTINCT FROM '72d23c5024f4363d8fa65ebf3291a613' THEN RAISE EXCEPTION 'Readiness definition differs: neo_go_live_readiness(uuid)'; END IF;
 IF md5(pg_get_functiondef('public.neo_menu_validation_states(uuid)'::regprocedure)) IS DISTINCT FROM '669fbc76950f32b5a98b6ef12fde3804' THEN RAISE EXCEPTION 'Readiness definition differs: neo_menu_validation_states(uuid)'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.neo_readiness_org(_branch uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public
AS $function$
DECLARE org uuid:=public.current_org_id();
BEGIN
 IF org IS NULL OR auth.uid() IS NULL OR (public.is_org_admin() OR public.has_permission('administration','workspace','edit')) IS NOT TRUE THEN
  RAISE EXCEPTION 'Not permitted to inspect workspace readiness' USING ERRCODE='42501';
 END IF;
 IF _branch IS NULL THEN
  IF (public.is_org_admin() OR public.current_access_scope() IN ('organisation','technical')) IS NOT TRUE THEN
   RAISE EXCEPTION 'Select an authorised property to inspect readiness' USING ERRCODE='42501';
  END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM public.branches b WHERE b.id=_branch AND b.organization_id=org)
    OR public.neo_branch_in_scope(_branch) IS NOT TRUE THEN
  RAISE EXCEPTION 'Readiness property is outside your access' USING ERRCODE='42501';
 END IF;
 RETURN org;
END $function$;
REVOKE ALL ON FUNCTION public.neo_readiness_org(uuid) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.neo_go_live_readiness(_branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.neo_readiness_org(_branch);
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
     AND oi.organization_id = _org AND oi.held = false
     AND coalesce(oi.status,'draft') NOT IN ('cancelled','voided')
     AND coalesce(o.status,'draft') NOT IN ('draft','open','new','cancelled','voided')
     AND (oi.station_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.station_ticket_items sti JOIN public.station_tickets t ON t.id=sti.ticket_id
        WHERE sti.order_item_id=oi.id AND sti.remake_of_id IS NULL
          AND sti.organization_id=_org AND t.organization_id=_org
          AND t.order_id=o.id AND t.branch_id IS NOT DISTINCT FROM o.branch_id
          AND t.station_id=oi.station_id
          AND coalesce(sti.status,'new') NOT IN ('cancelled','voided')
          AND coalesce(t.status,'new') NOT IN ('cancelled','voided')));
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
     AND (now() AT TIME ZONE public.neo_fact_timezone(_org,_branch))::date BETWEEN p.starts_on AND p.ends_on;
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'finance', 'domain', 'Finance', 'label', 'Accounting period open',
    'status', CASE WHEN _n > 0 THEN 'ready' ELSE 'blocked' END,
    'detail', CASE WHEN _n > 0 THEN 'An accounting period is open for today'
                   ELSE 'No open accounting period covering today' END,
    'count', _n, 'route', '/finance', 'extra', COALESCE(_fin, '{}'::jsonb)));

  -- A failed Finance probe must remain an unverified gate, not a green period check.
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key','finance_configuration','domain','Finance','label','Finance setup verified',
    'status',CASE WHEN _fin IS NULL OR jsonb_typeof(_fin)<>'object' OR _fin->>'ok' IS DISTINCT FROM 'true'
                   OR _fin->>'ready' IS NULL OR _fin->>'ready' NOT IN ('true','false') OR jsonb_typeof(_fin->'blocking') IS DISTINCT FROM 'array' THEN 'unknown'
                  WHEN _fin->>'ready'='true' AND _fin->'blocking'='[]'::jsonb THEN 'ready' ELSE 'blocked' END,
    'detail',CASE WHEN _fin IS NULL THEN 'Finance setup could not be verified. Review Finance readiness before certification.'
                  WHEN _fin->>'ready'='true' AND _fin->'blocking'='[]'::jsonb THEN 'Finance setup returned no blocking configuration findings.'
                  ELSE 'Finance setup is incomplete or its evidence could not be verified.' END,
    'count',0,'route','/finance'));

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
      WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(_checks) c WHERE c->>'status' = 'unknown') THEN 'unknown'
      WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(_checks) c WHERE c->>'status' = 'attention') THEN 'attention'
      ELSE 'ready' END,
    'checks', _checks);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.neo_menu_validation_states(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(item_id uuid, branch_id uuid, name text, state text, issues text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid:=public.neo_readiness_org(_branch);
BEGIN
 RETURN QUERY
  WITH scoped AS (
    SELECT mi.*
      FROM public.menu_items mi
     WHERE mi.organization_id = org
       AND (_branch IS NULL OR mi.branch_id IS NULL OR mi.branch_id = _branch)
  ), flagged AS (
    SELECT s.id,
           s.branch_id,
           s.name,
           ARRAY_REMOVE(ARRAY[
             CASE WHEN s.station_id IS NULL THEN 'missing-station' END,
             CASE WHEN s.category_id IS NULL THEN 'missing-category' END,
             CASE WHEN COALESCE(s.image_url, '') = '' THEN 'missing-image' END,
             CASE WHEN NOT EXISTS (
               SELECT 1 FROM public.recipes r
                WHERE r.menu_item_id = s.id AND r.organization_id = s.organization_id
                  AND r.status IN ('active', 'approved')
             ) THEN 'missing-recipe' END,
             CASE WHEN EXISTS (
               SELECT 1 FROM public.recipes r
                WHERE r.menu_item_id = s.id AND r.organization_id = s.organization_id
                  AND r.status IN ('active', 'approved')
                  AND NOT EXISTS (SELECT 1 FROM public.recipe_ingredients ri WHERE ri.recipe_id = r.id)
             ) THEN 'incomplete-recipe' END,
             CASE WHEN (s.base_price IS NULL OR s.base_price <= 0 OR s.base_price::text IN ('NaN','Infinity','-Infinity')) THEN 'missing-price' END,
             CASE WHEN s.publish_status = 'draft' THEN 'draft' END
           ], NULL) AS issues
      FROM scoped s
  )
  SELECT f.id,
         f.branch_id,
         f.name,
         CASE
           WHEN CARDINALITY(f.issues) = 0 THEN 'ready'
           WHEN 'draft' = ANY(f.issues) THEN 'draft'
           WHEN 'missing-price' = ANY(f.issues) THEN 'invalid-relationship'
           WHEN 'missing-station' = ANY(f.issues) OR 'missing-category' = ANY(f.issues) THEN 'missing-mapping'
           WHEN 'missing-recipe' = ANY(f.issues) OR 'incomplete-recipe' = ANY(f.issues) THEN 'missing-recipe'
           ELSE 'missing-image'
         END,
         f.issues
    FROM flagged f;
END $function$;
NOTIFY pgrst,'reload schema';
COMMIT;
