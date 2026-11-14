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

BEGIN;
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_laundry_folio_evidence(uuid,uuid,uuid,uuid,uuid,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Laundry evidence helper already exists; inspect before replacing'; END IF;
 IF md5(pg_get_functiondef('public.laundry_post_charge(uuid)'::regprocedure)) IS DISTINCT FROM '1de16c25ea669167c0bbd1fa980f7128' THEN RAISE EXCEPTION 'Laundry definition differs: laundry_post_charge(uuid)'; END IF;
 IF md5(pg_get_functiondef('public.neo_laundry_retry_posting(uuid)'::regprocedure)) IS DISTINCT FROM '1565589e330407606ece35e7440fe7ef' THEN RAISE EXCEPTION 'Laundry definition differs: neo_laundry_retry_posting(uuid)'; END IF;
 IF md5(pg_get_functiondef('public.neo_laundry_order_advance(uuid,text,text)'::regprocedure)) IS DISTINCT FROM '6df59f0b81b01c3abce5b32a9eeb020f' THEN RAISE EXCEPTION 'Laundry definition differs: neo_laundry_order_advance(uuid,text,text)'; END IF;
 IF md5(pg_get_functiondef('public.neo_receipt_resolve_journal()'::regprocedure)) IS DISTINCT FROM '4d20f148f7d8d99c751d272e3869e140' THEN RAISE EXCEPTION 'Laundry definition differs: neo_receipt_resolve_journal()'; END IF;
 IF md5(pg_get_functiondef('public.neo_finance_post_txn(text,uuid,boolean)'::regprocedure)) IS DISTINCT FROM 'b65eb27ced4ee472d51c9288aa86f534' THEN RAISE EXCEPTION 'Laundry definition differs: neo_finance_post_txn(text,uuid,boolean)'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.neo_laundry_folio_evidence(_org uuid,_branch uuid,_order uuid,_folio uuid,_line uuid,_journal uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public
AS $function$
DECLARE o public.guest_laundry_orders; f public.folios; l public.folio_lines;
 j public.journal_entries; n integer; d numeric; c numeric; revenue numeric; vat numeric; receivable numeric; bad integer; v_revenue_code text;
BEGIN
 SELECT * INTO o FROM public.guest_laundry_orders WHERE id=_order AND organization_id=_org AND branch_id IS NOT DISTINCT FROM _branch;
 IF o.id IS NULL OR o.status NOT IN ('delivered','completed','closed') OR coalesce(o.total,0)<=0
    OR o.total::text IN ('NaN','Infinity','-Infinity') OR coalesce(o.tax_amount,0)<0 OR coalesce(o.tax_amount,0)>o.total
    OR o.tax_amount::text IN ('NaN','Infinity','-Infinity') THEN RETURN jsonb_build_object('ok',false,'reason','invalid_laundry_source'); END IF;
 SELECT * INTO f FROM public.folios WHERE id=_folio AND organization_id=_org AND branch_id IS NOT DISTINCT FROM _branch
   AND (o.folio_id IS NULL OR o.folio_id=id) AND (o.reservation_id IS NULL OR reservation_id=o.reservation_id);
 IF f.id IS NULL OR f.currency IS DISTINCT FROM public.neo_fact_currency(_org,_branch) THEN RETURN jsonb_build_object('ok',false,'reason','invalid_folio_scope_or_currency'); END IF;
 SELECT * INTO l FROM public.folio_lines WHERE id=_line AND folio_id=f.id AND organization_id=_org AND branch_id IS NOT DISTINCT FROM _branch
   AND source_module='laundry' AND (source_record_uuid=_order OR source_record_id=_order::text)
   AND status='posted' AND line_type='charge' AND category='laundry'
   AND net_amount=o.total AND tax_amount=coalesce(o.tax_amount,0) AND coalesce(service_charge_amount,0)=0
   AND gross_amount-coalesce(discount_amount,0)=o.total-coalesce(o.tax_amount,0);
 IF l.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','invalid_folio_charge'); END IF;
 SELECT count(*) INTO n FROM public.folio_lines x WHERE x.organization_id=_org AND x.source_module='laundry'
   AND (x.source_record_uuid=_order OR x.source_record_id=_order::text) AND x.status='posted' AND x.line_type='charge';
 IF n<>1 THEN RETURN jsonb_build_object('ok',false,'reason','ambiguous_folio_charge'); END IF;
 SELECT count(*) INTO n FROM public.journal_entries x WHERE x.organization_id=_org AND x.branch_id IS NOT DISTINCT FROM _branch
   AND x.source_document_id=l.id AND x.source_document_type='folio_charge:revenue' AND x.status='posted'
   AND x.journal_type<>'reversal' AND x.reversed_by_journal_id IS NULL;
 IF n<>1 THEN RETURN jsonb_build_object('ok',false,'reason','missing_or_ambiguous_folio_journal'); END IF;
 SELECT * INTO j FROM public.journal_entries x WHERE x.organization_id=_org AND x.branch_id IS NOT DISTINCT FROM _branch
   AND x.source_document_id=l.id AND x.source_document_type='folio_charge:revenue' AND x.status='posted'
   AND x.journal_type<>'reversal' AND x.reversed_by_journal_id IS NULL;
 IF (_journal IS NOT NULL AND j.id<>_journal) OR j.currency IS DISTINCT FROM f.currency
   OR j.total_debit IS DISTINCT FROM o.total OR j.total_credit IS DISTINCT FROM o.total THEN RETURN jsonb_build_object('ok',false,'reason','journal_header_mismatch'); END IF;
 v_revenue_code:=public.neo_gl_revenue_code_scoped(_org,'laundry',NULL);
 SELECT coalesce(sum(x.debit),0),coalesce(sum(x.credit),0),
   coalesce(sum(x.credit-x.debit) FILTER(WHERE a.code=v_revenue_code),0),
   coalesce(sum(x.credit-x.debit) FILTER(WHERE a.code='2040'),0),
   coalesce(sum(x.debit-x.credit) FILTER(WHERE a.code='1060'),0),
   count(*) FILTER(WHERE a.id IS NULL OR a.organization_id IS DISTINCT FROM _org OR a.code NOT IN(v_revenue_code,'2040','1060')
     OR x.organization_id IS DISTINCT FROM _org OR x.branch_id IS DISTINCT FROM _branch
     OR x.debit<0 OR x.credit<0 OR (x.debit>0 AND x.credit>0)
     OR x.debit::text IN ('NaN','Infinity','-Infinity') OR x.credit::text IN ('NaN','Infinity','-Infinity'))
 INTO d,c,revenue,vat,receivable,bad FROM public.journal_entry_lines x LEFT JOIN public.chart_of_accounts a ON a.id=x.account_id WHERE x.journal_id=j.id;
 IF bad>0 OR d<>o.total OR c<>o.total OR receivable<>o.total OR vat<>coalesce(o.tax_amount,0) OR revenue<>o.total-coalesce(o.tax_amount,0)
 THEN RETURN jsonb_build_object('ok',false,'reason','journal_lines_mismatch'); END IF;
 RETURN jsonb_build_object('ok',true,'folio_id',f.id,'folio_line_id',l.id,'journal_id',j.id,'amount',o.total,'currency',f.currency);
END $function$;
REVOKE ALL ON FUNCTION public.neo_laundry_folio_evidence(uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.laundry_post_charge(_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE org uuid:=public.current_org_id(); o public.guest_laundry_orders; f public.folios; line uuid; n integer; evidence jsonb;
 prior text:=coalesce(current_setting('neo.system_posting',true),'off');
BEGIN
 IF org IS NULL OR (public.neo_system_posting() OR public.has_permission('laundry','edit') OR public.has_permission('laundry','approve')
    OR public.has_permission('laundry','complete') OR public.has_permission('laundry','deliver') OR public.has_permission('pms','folios.post_charge') OR public.is_org_admin()) IS NOT TRUE
 THEN RAISE EXCEPTION 'Not permitted to post laundry charges' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM public.guest_laundry_orders WHERE id=_order AND organization_id=org FOR UPDATE;
 IF o.id IS NULL THEN RAISE EXCEPTION 'Unknown laundry order'; END IF;
 IF public.neo_branch_in_scope(o.branch_id) IS NOT TRUE THEN RAISE EXCEPTION 'Laundry is outside your property scope' USING ERRCODE='42501'; END IF;
 IF o.status NOT IN ('delivered','completed','closed') THEN RETURN jsonb_build_object('ok',false,'reason','not_delivered'); END IF;
 IF o.total IS NULL OR o.total<=0 OR o.total::text IN ('NaN','Infinity','-Infinity')
    OR coalesce(o.tax_amount,0)<0 OR coalesce(o.tax_amount,0)>o.total OR o.tax_amount::text IN ('NaN','Infinity','-Infinity')
 THEN RETURN jsonb_build_object('ok',false,'reason','invalid_charge_amount'); END IF;
 IF o.posting_status='posted' THEN
  evidence:=public.neo_laundry_folio_evidence(org,o.branch_id,o.id,o.folio_id,o.folio_line_id,NULL);
  RETURN evidence||jsonb_build_object('already_posted',evidence->>'ok'='true');
 END IF;
 IF o.folio_id IS NOT NULL THEN
  SELECT * INTO f FROM public.folios WHERE id=o.folio_id AND organization_id=org AND branch_id IS NOT DISTINCT FROM o.branch_id
    AND (o.reservation_id IS NULL OR reservation_id=o.reservation_id) FOR UPDATE;
 ELSIF o.reservation_id IS NOT NULL THEN
  SELECT count(*) INTO n FROM public.folios WHERE organization_id=org AND branch_id IS NOT DISTINCT FROM o.branch_id
    AND reservation_id=o.reservation_id AND status='open' AND folio_type='guest';
  IF n=1 THEN SELECT * INTO f FROM public.folios WHERE organization_id=org AND branch_id IS NOT DISTINCT FROM o.branch_id
    AND reservation_id=o.reservation_id AND status='open' AND folio_type='guest' FOR UPDATE; END IF;
 END IF;
 IF f.id IS NULL OR f.status<>'open' OR f.currency IS DISTINCT FROM public.neo_fact_currency(org,o.branch_id)
 THEN RETURN jsonb_build_object('ok',false,'reason','missing_open_folio','detail','Link exactly one open guest folio in the same property and currency before posting.'); END IF;
 PERFORM set_config('neo.system_posting','on',true);
 line:=public.folio_post_charge(f.id,'laundry','Guest laundry '||coalesce(o.laundry_number,''),1,o.total-coalesce(o.tax_amount,0),coalesce(o.tax_amount,0),0,0,'laundry',o.id,'laundry','laundry:'||o.id::text,NULL);
 PERFORM set_config('neo.system_posting',prior,true);
 evidence:=public.neo_laundry_folio_evidence(org,o.branch_id,o.id,f.id,line,NULL);
 IF evidence->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Laundry folio accounting is not verified: %',evidence->>'reason'; END IF;
 UPDATE public.guest_laundry_orders SET posting_status='posted',folio_id=f.id,folio_line_id=line,posted_at=coalesce(posted_at,now()) WHERE id=o.id;
 RETURN evidence;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('neo.system_posting',prior,true); RAISE;
END $function$;
CREATE OR REPLACE FUNCTION public.neo_laundry_retry_posting(_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE org uuid:=public.current_org_id(); o public.guest_laundry_orders; result jsonb; evidence jsonb;
BEGIN
 IF org IS NULL OR auth.uid() IS NULL OR (public.has_permission('laundry','orders','edit') OR public.has_permission('laundry','orders','approve')
   OR public.has_permission('pms','folios','post_charge') OR public.has_permission('finance','postings','edit') OR public.is_org_admin()) IS NOT TRUE
 THEN RAISE EXCEPTION 'Not permitted to re-post laundry charges' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM public.guest_laundry_orders WHERE id=_order AND organization_id=org FOR UPDATE;
 IF o.id IS NULL THEN RAISE EXCEPTION 'Unknown laundry order'; END IF;
 IF public.neo_branch_in_scope(o.branch_id) IS NOT TRUE THEN RAISE EXCEPTION 'Laundry is outside your property scope' USING ERRCODE='42501'; END IF;
 IF o.status NOT IN ('delivered','completed','closed') THEN RETURN jsonb_build_object('ok',false,'reason','not_delivered'); END IF;
 IF o.posting_status='posted' THEN
  evidence:=public.neo_laundry_folio_evidence(org,o.branch_id,o.id,o.folio_id,o.folio_line_id,NULL);
  RETURN evidence||jsonb_build_object('already_posted',evidence->>'ok'='true','folio_charged',evidence->>'ok'='true');
 END IF;
 result:=public.neo_finance_post_source('laundry',_order,true);
 SELECT * INTO o FROM public.guest_laundry_orders WHERE id=_order AND organization_id=org;
 evidence:=public.neo_laundry_folio_evidence(org,o.branch_id,o.id,o.folio_id,o.folio_line_id,NULL);
 IF result->>'ok'='true' AND evidence->>'ok'='true' THEN RETURN evidence||jsonb_build_object('folio_charged',true); END IF;
 UPDATE public.guest_laundry_orders SET posting_status='blocked',
   discrepancy_notes=coalesce(result->>'detail',evidence->>'reason',result->>'reason','Laundry posting could not be verified') WHERE id=o.id AND coalesce(posting_status,'unposted')<>'posted';
 RETURN jsonb_build_object('ok',false,'reason',coalesce(evidence->>'reason',result->>'reason'),'detail',coalesce(result->>'detail',evidence->>'reason'),'folio_charged',false);
END $function$;
CREATE OR REPLACE FUNCTION public.neo_laundry_order_advance(_order uuid, _status text, _note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _row public.guest_laundry_orders%ROWTYPE;
  _posting jsonb;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF (
    public.has_permission('laundry','orders','edit') OR
    public.has_permission('laundry','orders','approve') OR
    public.is_org_admin()
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Not permitted to update guest laundry' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _row
    FROM public.guest_laundry_orders
   WHERE id=_order AND organization_id=_org
   FOR UPDATE;
  IF _row.id IS NULL THEN RAISE EXCEPTION 'Laundry order not found'; END IF;


  -- neo_laundry_scope_transition_guard_v1
  IF auth.uid() IS NULL
     OR public.neo_branch_in_scope(_row.branch_id) IS NOT TRUE
  THEN
    RAISE EXCEPTION 'Laundry order is outside your branch scope'
      USING ERRCODE = '42501';
  END IF;

  IF _status IS NULL OR (
    _status IS DISTINCT FROM _row.status
    AND NOT COALESCE(
      CASE _row.status
        WHEN 'requested' THEN
          _status IN ('collected', 'on-hold', 'cancelled')
        WHEN 'awaiting-collection' THEN
          _status IN ('collected', 'on-hold', 'cancelled')
        WHEN 'collected' THEN
          _status IN ('on-hold', 'disputed', 'cancelled')
        WHEN 'ready-for-delivery' THEN
          _status IN ('delivered', 'on-hold', 'disputed')
        WHEN 'delivered' THEN
          _status IN ('completed', 'disputed')
        WHEN 'on-hold' THEN
          _status IN ('collected', 'disputed', 'cancelled')
        WHEN 'disputed' THEN
          _status IN ('on-hold', 'ready-for-delivery', 'cancelled')
        ELSE false
      END,
      false
    )
  ) THEN
    RAISE EXCEPTION 'Laundry transition from % to % is not permitted',
      _row.status, _status
      USING ERRCODE = '22023';
  END IF;

  IF _status = _row.status THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'status',_row.status,
      'posting_status',_row.posting_status);
  END IF;

  IF _status = 'delivered' THEN
    IF NOT EXISTS(SELECT 1 FROM public.laundry_batches b WHERE b.guest_order_id=_order AND b.organization_id=_org
          AND b.branch_id IS NOT DISTINCT FROM _row.branch_id AND b.batch_kind='guest' AND b.status IN ('ready','completed','closed'))
       OR EXISTS(SELECT 1 FROM public.laundry_batches b WHERE b.guest_order_id=_order AND b.organization_id=_org
          AND b.branch_id IS NOT DISTINCT FROM _row.branch_id AND b.batch_kind='guest' AND coalesce(b.status,'unknown') NOT IN ('ready','completed','closed','cancelled')) THEN
      RAISE EXCEPTION 'Reconcile all active guest laundry batches before handover' USING ERRCODE='23514';
    END IF;
    UPDATE public.guest_laundry_orders
       SET status='delivered',
           delivered_at=COALESCE(delivered_at,now()),
           delivery_confirmed_by=COALESCE(delivery_confirmed_by,auth.uid()::text),
           discrepancy_notes=concat_ws(' ',NULLIF(discrepancy_notes,''),NULLIF(btrim(_note),'')),
           updated_at=now()
     WHERE id=_order;

    -- Delivery and accounting are separate facts.  Retry the canonical Finance
    -- posting and leave the order visibly blocked when the guest/folio/payment
    -- context is not sufficient rather than pretending it was billed.
    _posting := public.neo_laundry_retry_posting(_order);

    SELECT * INTO _row FROM public.guest_laundry_orders WHERE id=_order;
    PERFORM public.log_audit_event(
      _org,'laundry.order.delivered','laundry',_order::text,
      jsonb_build_object('status','ready-for-delivery'),
      jsonb_build_object('status',_row.status,'delivered_at',_row.delivered_at,
                         'posting_status',_row.posting_status,'posting',_posting),
      COALESCE(NULLIF(btrim(_note),''),'Guest laundry handed back'));

    RETURN jsonb_build_object('ok',true,'status',_row.status,
      'delivered_at',_row.delivered_at,'posting_status',_row.posting_status,
      'posting',_posting);
  END IF;

  IF _status = 'completed' THEN
    UPDATE public.guest_laundry_orders
       SET status='completed',updated_at=now()
     WHERE id=_order;
    RETURN jsonb_build_object('ok',true,'status','completed');
  END IF;

  UPDATE public.guest_laundry_orders
     SET status=_status,
         collected_at=CASE WHEN _status='collected' AND collected_at IS NULL THEN now() ELSE collected_at END,
         discrepancy_notes=CASE WHEN _status IN ('on-hold','disputed')
           THEN concat_ws(' ',NULLIF(discrepancy_notes,''),NULLIF(btrim(_note),''))
           ELSE discrepancy_notes END,
         updated_at=now()
   WHERE id=_order;

  RETURN jsonb_build_object('ok',true,'status',_status);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.neo_finance_post_txn(_source_type text, _source_id uuid, _silent boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  branch uuid; cur text; ref text; occurred date; amount numeric := 0;
  posting text := 'revenue'; lines jsonb := '[]'::jsonb; res jsonb;
  customer uuid; net numeric; tax numeric; svc numeric; settle text;
  o public.pos_orders; fl public.folio_lines; pay public.payments;
  ev public.event_bookings; inv public.invoices; si public.supplier_invoices;
  sp public.supplier_payments; lo public.guest_laundry_orders; deliv record;
  paid numeric; remainder numeric; key text;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT _silent AND NOT (public.is_org_admin()
        OR public.has_permission('finance','edit') OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_source_type || ':' || _source_id::text, 0));

  IF _source_type = 'pos_order' THEN
    SELECT * INTO o FROM public.pos_orders
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := o.branch_id; ref := o.order_number; customer := o.customer_id;
    occurred := (coalesce(o.closed_at, o.created_at))::date; amount := coalesce(o.grand_total,0);
    IF o.status NOT IN ('closed','paid','settled','completed','charged-to-room') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Order is ' || o.status || '. Draft, sent, ready and served orders are not revenue.');
    END IF;

    IF o.folio_id IS NOT NULL THEN
      posting := 'room_charge';
      res := public.neo_post_pos_order(o.id);
      PERFORM public.neo_record_posting_receipt(org, branch, 'pos', o.id, ref,
        CASE WHEN coalesce((res->>'ok')::boolean,false) THEN 'posted' ELSE 'blocked' END,
        amount, public.neo_fact_currency(org, branch), nullif(res->>'folio_line_id','')::uuid,
        'Routed to folio ' || o.folio_id::text || ' - revenue is recognised on the folio charge, not on the order.',
        NULL, occurred);
      UPDATE public.finance_posting_receipts SET posting_type = posting
        WHERE organization_id = org AND idempotency_key = 'pos:' || o.id::text;
      SELECT coalesce(res,'{}'::jsonb) || jsonb_build_object(
        'posting_type',posting,'posting_receipt_id',r.id,'folio_line_id',r.folio_line_id,'journal_id',r.journal_id,
        'ok',r.status='posted' AND r.folio_line_id IS NOT NULL AND r.journal_id IS NOT NULL,
        'reason',CASE WHEN r.status='posted' AND r.folio_line_id IS NOT NULL AND r.journal_id IS NOT NULL
                     THEN 'room_charge_reconciled' ELSE 'room_charge_journal_unverified' END)
      INTO res FROM public.finance_posting_receipts r
      WHERE r.organization_id=org AND r.idempotency_key='pos:'||o.id::text;
      RETURN coalesce(res,jsonb_build_object('ok',false,'reason','room_charge_receipt_missing'));
    END IF;

    tax := coalesce(o.tax_total,0); svc := coalesce(o.service_charge_total,0);
    amount := greatest(coalesce(o.grand_total,0),
                       coalesce(o.subtotal,0) - coalesce(o.discount_total,0));
    net := amount - tax - svc;
    IF o.corporate_account_id IS NOT NULL AND coalesce(o.paid_total,0) < amount THEN
      settle := '1060';
    ELSE
      -- The money account follows the receipt: the account the cashier chose,
      -- otherwise the account this property uses for that tender.
      SELECT public.neo_gl_account_code(org, p.method, p.destination_account_id) INTO settle
        FROM public.pos_payments p WHERE p.order_id = o.id
         AND p.status IN ('confirmed','paid','completed','captured','settled')
        ORDER BY p.amount DESC LIMIT 1;
      settle := coalesce(settle, public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Settlement ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, o.order_type, NULL), 'credit', net),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'),
      jsonb_build_object('code', '2050', 'credit', svc, 'description', 'Service charge'));

  ELSIF _source_type = 'folio_charge' THEN
    SELECT * INTO fl FROM public.folio_lines
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF fl.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := fl.branch_id; ref := coalesce(fl.reference, fl.description); customer := fl.customer_id;
    occurred := coalesce(fl.operational_date, fl.posting_date::date);
    IF fl.status <> 'posted' OR coalesce(fl.line_type,'charge') = 'payment' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only posted folio charges are recognised.');
    END IF;
    tax := coalesce(fl.tax_amount,0);
    svc := coalesce(fl.service_charge_amount,0);
    amount := coalesce(fl.gross_amount,0) - coalesce(fl.discount_amount,0) + tax + svc;
    net := coalesce(fl.gross_amount,0) - coalesce(fl.discount_amount,0);
    IF amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', '1060', 'debit', amount, 'description', 'Guest ledger ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, fl.category, fl.revenue_centre), 'credit', net),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'),
      jsonb_build_object('code', '2050', 'credit', svc, 'description', 'Service charge'));

  ELSIF _source_type = 'folio_payment' THEN
    SELECT * INTO pay FROM public.payments
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF pay.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := pay.branch_id; ref := pay.receipt_number; customer := pay.customer_id;
    occurred := coalesce(pay.paid_at, pay.created_at)::date; amount := coalesce(pay.amount,0);
    posting := 'collection';
    IF coalesce(pay.status,'') NOT IN ('confirmed','completed','paid','succeeded','captured') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only confirmed receipts reduce the outstanding balance.');
    END IF;
    IF amount = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', public.neo_gl_account_code(org, pay.method, pay.destination_account_id),
                         'debit', amount, 'description', 'Receipt ' || coalesce(ref,'')),
      jsonb_build_object('code', '1060', 'credit', amount, 'description', 'Guest / customer ledger'));

  ELSIF _source_type = 'event_deposit' THEN
    SELECT * INTO ev FROM public.event_bookings
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF ev.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := ev.branch_id; ref := ev.event_reference; customer := ev.customer_id;
    occurred := coalesce(ev.confirmed_at::date, ev.event_date); posting := 'deposit';
    amount := coalesce(ev.deposit_paid, 0);
    IF amount <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'No deposit has been received. Forecast is never revenue.');
    END IF;
    SELECT public.neo_gl_account_code(org, p.method, p.destination_account_id) INTO settle
      FROM public.payments p
     WHERE p.organization_id = org AND p.source_module = 'events' AND p.source_record_id = ev.id
       AND coalesce(p.status,'') IN ('confirmed','completed','paid','succeeded','captured')
     ORDER BY p.amount DESC LIMIT 1;
    settle := coalesce(settle, public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Event deposit ' || coalesce(ref,'')),
      jsonb_build_object('code', '2030', 'credit', amount, 'description', 'Event deposit held'));

  ELSIF _source_type = 'event_invoice' THEN
    SELECT * INTO inv FROM public.invoices
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF inv.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := inv.branch_id; ref := inv.invoice_number; customer := inv.customer_id;
    occurred := inv.issue_date; posting := 'invoice'; amount := coalesce(inv.total,0);
    IF coalesce(inv.status,'draft') NOT IN ('issued','sent','partially_paid','paid','overdue') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Draft and cancelled invoices are not receivables.');
    END IF;
    net := coalesce(inv.subtotal,0) - coalesce(inv.discount_total,0);
    lines := jsonb_build_array(
      jsonb_build_object('code', '1060', 'debit', amount, 'description', 'Invoice ' || coalesce(ref,'')),
      jsonb_build_object('code', CASE WHEN inv.event_booking_id IS NOT NULL THEN public.neo_gl_revenue_code_scoped(org, 'events', NULL) ELSE '4090' END,
                         'credit', net),
      jsonb_build_object('code', '2050', 'credit', coalesce(inv.service_charge_total,0),
                         'description', 'Service charge'),
      jsonb_build_object('code', '2040', 'credit', coalesce(inv.tax_total,0), 'description', 'VAT'));

  ELSIF _source_type = 'event_earned' THEN
    SELECT * INTO ev FROM public.event_bookings
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF ev.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := ev.branch_id; ref := ev.event_reference; customer := ev.customer_id;
    occurred := ev.event_date; posting := 'earned'; amount := coalesce(ev.total_amount,0);
    IF ev.status NOT IN ('completed','closed') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Event is ' || ev.status || '. Confirmed and provisional bookings are forecast, not revenue.');
    END IF;
    IF amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    paid := least(coalesce(ev.deposit_paid,0), amount);
    remainder := amount - paid;
    lines := jsonb_build_array(
      jsonb_build_object('code', '2030', 'debit', paid, 'description', 'Deposit applied'),
      jsonb_build_object('code', '1060', 'debit', remainder, 'description', 'Event receivable'),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, 'events', NULL), 'credit', amount, 'description', 'Event revenue ' || coalesce(ref,'')));

  ELSIF _source_type = 'event_cancellation' THEN
    SELECT * INTO ev FROM public.event_bookings
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF ev.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := ev.branch_id; ref := ev.event_reference; customer := ev.customer_id;
    occurred := coalesce(ev.cancelled_at::date, ev.event_date); posting := 'cancellation';
    IF ev.status <> 'cancelled' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle');
    END IF;
    PERFORM public.neo_finance_reverse_posting('event_earned', ev.id, 'earned', 'Event cancelled');
    amount := coalesce(ev.cancellation_fee, 0);
    paid := coalesce(ev.deposit_paid, 0);
    remainder := greatest(paid - amount, 0);
    IF amount = 0 AND remainder = 0 THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'nothing_to_recognise');
    END IF;
    SELECT public.neo_gl_account_code(org, p.method, p.destination_account_id) INTO settle
      FROM public.payments p
     WHERE p.organization_id = org AND p.source_module = 'events' AND p.source_record_id = ev.id
     ORDER BY p.amount DESC LIMIT 1;
    settle := coalesce(settle, public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    lines := jsonb_build_array(
      jsonb_build_object('code', '2030', 'debit', paid, 'description', 'Deposit released'),
      jsonb_build_object('code', '1060', 'debit', greatest(amount - paid, 0),
                         'description', 'Cancellation receivable'),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, 'events', NULL), 'credit', amount, 'description', 'Cancellation fee ' || coalesce(ref,'')),
      jsonb_build_object('code', settle, 'credit', remainder, 'description', 'Refund to client'));
    amount := greatest(amount, paid);

  ELSIF _source_type = 'delivery_order' THEN
    SELECT d.id, d.branch_id, d.order_number, d.customer_id, d.grand_total, d.tax_total,
           d.order_status, d.payment_status, d.payment_method, d.delivered_at, d.created_at
      INTO deliv FROM public.delivery_orders d
      WHERE d.id = _source_id AND d.organization_id = org FOR UPDATE;
    IF deliv.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := deliv.branch_id; ref := deliv.order_number; customer := deliv.customer_id;
    occurred := coalesce(deliv.delivered_at, deliv.created_at)::date;
    amount := coalesce(deliv.grand_total,0); tax := coalesce(deliv.tax_total,0);
    IF deliv.order_status NOT IN ('delivered','completed') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only completed deliveries are recognised.');
    END IF;
    IF deliv.payment_status IN ('paid','settled','completed') THEN
      SELECT public.neo_gl_account_code(org, coalesce(p.method, deliv.payment_method), p.destination_account_id)
        INTO settle
        FROM public.payments p
       WHERE p.organization_id = org AND p.source_module = 'delivery' AND p.source_record_id = deliv.id
         AND coalesce(p.status,'') IN ('confirmed','completed','paid','succeeded','captured')
       ORDER BY p.amount DESC LIMIT 1;
      settle := coalesce(settle, public.neo_gl_account_code(org, deliv.payment_method, NULL), '1010');
    ELSE
      settle := '1060';
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Delivery ' || coalesce(ref,'')),
      jsonb_build_object('code', '4070', 'credit', amount - tax),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'));

  ELSIF _source_type = 'laundry_order' THEN
    SELECT * INTO lo FROM public.guest_laundry_orders
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF lo.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := lo.branch_id; ref := lo.laundry_number;
    occurred := coalesce(lo.delivered_at, lo.created_at)::date; amount := coalesce(lo.total,0);
    IF lo.status NOT IN ('delivered','completed','closed') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only completed laundry orders are recognised.');
    END IF;
    IF lo.folio_id IS NULL AND (lo.reservation_id IS NOT NULL OR lo.resident IS TRUE) THEN
      RETURN jsonb_build_object('ok',false,'reason','resident_laundry_missing_folio',
        'detail','Resident laundry must reach a guest folio; it cannot be treated as an assumed cash collection.');
    END IF;
    IF lo.folio_id IS NOT NULL THEN
      posting := 'folio_charge';
      res := public.laundry_post_charge(lo.id);
      PERFORM public.neo_record_posting_receipt(org, branch, 'laundry', lo.id, ref,
        CASE WHEN coalesce((res->>'ok')::boolean,false) THEN 'posted' ELSE 'blocked' END,
        amount, public.neo_fact_currency(org, branch), nullif(res->>'folio_line_id','')::uuid,
        'Charged to the guest folio - revenue is recognised on the folio charge.', NULL, occurred);
      UPDATE public.finance_posting_receipts SET posting_type = posting
        WHERE organization_id = org AND source_module = 'laundry' AND source_id = lo.id;
      RETURN coalesce(res,'{}'::jsonb) || jsonb_build_object('posting_type', posting);
    END IF;
    tax := coalesce(lo.tax_amount,0);
    settle := coalesce(public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Laundry ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, 'laundry', NULL), 'credit', amount - tax),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'));

  ELSIF _source_type = 'supplier_invoice' THEN
    SELECT * INTO si FROM public.supplier_invoices
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF si.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := si.branch_id; ref := si.invoice_number; occurred := si.invoice_date;
    amount := coalesce(si.amount,0); tax := coalesce(si.tax_amount,0); posting := 'payable';
    IF si.approved_at IS NULL OR si.status NOT IN ('approved','matched','partially_paid','paid') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only approved supplier invoices become payables. Requests and purchase orders do not.');
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', '1070', 'debit', amount - tax, 'description', 'Goods / services received'),
      jsonb_build_object('code', '2040', 'debit', tax, 'description', 'Input VAT'),
      jsonb_build_object('code', '2010', 'credit', amount, 'description', 'Supplier invoice ' || coalesce(ref,'')));

  ELSIF _source_type = 'supplier_payment' THEN
    SELECT * INTO sp FROM public.supplier_payments
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF sp.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := sp.branch_id; ref := sp.payment_number; occurred := sp.paid_on;
    amount := coalesce(sp.amount,0); posting := 'payable_payment';
    IF sp.status NOT IN ('paid','completed','settled') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle');
    END IF;
    -- Money leaves the account the hotel actually paid from.
    lines := jsonb_build_array(
      jsonb_build_object('code', '2010', 'debit', amount, 'description', 'Supplier payment ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_account_code(org, sp.method, sp.bank_account_id),
                         'credit', amount));

  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_source_type');
  END IF;

  cur := public.neo_fact_currency(org, branch);
  occurred := coalesce(occurred, (now() AT TIME ZONE public.neo_fact_timezone(org, branch))::date);
  key := _source_type || ':' || _source_id::text || ':' || posting;

  res := public.neo_gl_post(org, branch, split_part(_source_type,'_',1), _source_type, _source_id,
                            posting, occurred, cur,
                            initcap(replace(_source_type,'_',' ')) || ' ' || coalesce(ref,''),
                            lines, customer, NULL);

  -- A duplicate key or ok flag alone is not evidence of a completed posting.
  IF res->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS(
    SELECT 1 FROM public.journal_entries j
    CROSS JOIN LATERAL(SELECT coalesce(sum(l.debit),0) AS d,coalesce(sum(l.credit),0) AS c
      FROM public.journal_entry_lines l WHERE l.journal_id=j.id) actual
    WHERE j.id=nullif(res->>'journal_id','')::uuid AND j.organization_id=org
      AND j.branch_id IS NOT DISTINCT FROM branch AND j.status='posted'
      AND j.reversed_by_journal_id IS NULL AND j.currency=cur
      AND j.source_document_id=_source_id AND j.source_document_type=_source_type||':'||posting
      AND actual.d=round(amount,2) AND actual.c=round(amount,2)
      AND j.total_debit=actual.d AND j.total_credit=actual.c
      AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_id=j.id
        AND (l.organization_id IS DISTINCT FROM org OR l.branch_id IS DISTINCT FROM branch))
  ) THEN
    RAISE EXCEPTION 'Posting did not produce a matching balanced posted journal' USING ERRCODE='23514';
  END IF;

  PERFORM public.neo_record_posting_receipt(org, branch, _source_type, _source_id, ref,
    'posted', amount, cur, NULL,
    CASE WHEN coalesce((res->>'duplicate_prevented')::boolean,false)
         THEN 'Duplicate replay prevented - the existing journal was reused.'
         ELSE 'Posted to journal ' || (res->>'journal_id') END,
    NULL, occurred);

  UPDATE public.finance_posting_receipts
     SET posting_type = posting, journal_id = (res->>'journal_id')::uuid
   WHERE organization_id = org AND source_module = _source_type AND source_id = _source_id;

  PERFORM public.emit_domain_event(org, branch, 'finance.posted', _source_type, _source_id,
    jsonb_build_object('posting_type', posting, 'amount', amount, 'currency', cur,
                       'journal_id', res->>'journal_id', 'occurred_on', occurred),
    'finance.posted:' || key, customer);

  RETURN res || jsonb_build_object('source_type', _source_type, 'source_id', _source_id,
                                   'posting_type', posting, 'amount', amount);
EXCEPTION WHEN OTHERS THEN
  PERFORM public.neo_record_posting_receipt(org, branch, _source_type, _source_id, ref,
    'failed', amount, coalesce(cur,'KES'), NULL, NULL, SQLERRM, occurred);
  IF _silent THEN RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', SQLERRM); END IF;
  RAISE;
END $function$
;
CREATE OR REPLACE FUNCTION public.neo_receipt_resolve_journal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE evidence jsonb; laundry_folio uuid; laundry_line uuid;
BEGIN
  IF NEW.source_module IN ('laundry','laundry_order') AND lower(coalesce(NEW.status,''))='posted' THEN
    SELECT o.folio_id,coalesce(NEW.folio_line_id,o.folio_line_id) INTO laundry_folio,laundry_line
      FROM public.guest_laundry_orders o WHERE o.id=NEW.source_id AND o.organization_id=NEW.organization_id
        AND o.branch_id IS NOT DISTINCT FROM NEW.branch_id;
    IF laundry_folio IS NOT NULL OR laundry_line IS NOT NULL THEN
      evidence:=public.neo_laundry_folio_evidence(NEW.organization_id,NEW.branch_id,NEW.source_id,laundry_folio,laundry_line,NEW.journal_id);
      IF evidence->>'ok'='true' AND NEW.amount=(evidence->>'amount')::numeric AND NEW.currency=evidence->>'currency' THEN
        NEW.folio_line_id:=(evidence->>'folio_line_id')::uuid;NEW.journal_id:=(evidence->>'journal_id')::uuid;NEW.last_error:=NULL;
      ELSE NEW.status:='blocked';NEW.last_error:='Laundry charge evidence: '||coalesce(evidence->>'reason','receipt_amount_or_currency_mismatch');END IF;
      RETURN NEW;
    END IF;
  END IF;
  -- A POS room transfer is backed by its folio journal, not another POS revenue posting.
  IF NEW.source_module IN ('pos','pos_order') AND lower(coalesce(NEW.status,''))='posted'
     AND EXISTS(SELECT 1 FROM public.pos_orders o WHERE o.id=NEW.source_id
       AND o.organization_id=NEW.organization_id AND o.branch_id IS NOT DISTINCT FROM NEW.branch_id
       AND o.folio_id IS NOT NULL) THEN
    evidence:=public.neo_pos_room_charge_evidence(NEW.organization_id,NEW.branch_id,NEW.source_id,
      NEW.folio_line_id,NEW.journal_id);
    IF evidence->>'ok'='true' AND NEW.amount=(evidence->>'amount')::numeric
       AND NEW.currency=evidence->>'currency' THEN
      NEW.folio_line_id:=(evidence->>'folio_line_id')::uuid;
      NEW.journal_id:=(evidence->>'journal_id')::uuid;
      NEW.last_error:=NULL;
    ELSE
      NEW.status:='blocked';
      NEW.last_error:='Room charge evidence: '||coalesce(evidence->>'reason','receipt_amount_or_currency_mismatch');
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.journal_id IS NULL AND lower(coalesce(NEW.status,'')) = 'posted' THEN
    SELECT j.id INTO NEW.journal_id
      FROM public.journal_entries j
     WHERE j.organization_id = NEW.organization_id
       AND j.source_document_id = NEW.source_id
       AND j.status = 'posted'
       AND abs(coalesce(j.total_debit,0) - coalesce(j.total_credit,0)) < 0.01
     ORDER BY j.posted_at DESC NULLS LAST, j.created_at DESC
     LIMIT 1;
  END IF;
  RETURN NEW;
END $function$
;
NOTIFY pgrst,'reload schema';
COMMIT;

BEGIN READ ONLY;
WITH code AS(SELECT signature,md5(pg_get_functiondef(to_regprocedure('public.'||signature)))=expected AS matches FROM(VALUES ('neo_go_live_readiness(uuid)','dbb60fda680cb80ece3a3536b4f11c81'),
('neo_menu_validation_states(uuid)','2a3ae9b07bdbbf2de024c9a8ba21bab5'),
('neo_readiness_org(uuid)','a7dba18048cea5941fd40c6995b8723a'),
('laundry_post_charge(uuid)','afc7c184aa3aa20be68e76571f83addc'),
('neo_finance_post_txn(text,uuid,boolean)','49289eb4484d9655afe8e148f6e3b48a'),
('neo_laundry_folio_evidence(uuid,uuid,uuid,uuid,uuid,uuid)','b83c8fd088f06ffa3c2baa03ae3ece91'),
('neo_laundry_order_advance(uuid,text,text)','d7cb828bca783dff7514966acb53f5b0'),
('neo_laundry_retry_posting(uuid)','11016e29b00cedda7a0d917a0ba17aed'),
('neo_receipt_resolve_journal()','27ffa904b2f57c57078f438fe6baf45c'))v(signature,expected)),
 retained AS(SELECT signature,md5(pg_get_functiondef(to_regprocedure('public.'||signature)))=expected AS unchanged FROM(VALUES ('neo_grn_post_accrual(uuid)','7ddbe107f01db6513a2b3d23d6b8f213'),
('neo_laundry_completion_guard()','b4908b48fbbac89995f83fbb8f3421ed'),
('neo_pos_order_is_kitchen_bound(uuid,uuid)','22247017c1c21289a73472141c9fd3bc'),
('neo_pos_route_tickets_internal(uuid,uuid)','1c3f7c0630f9997ae6127c781a779b73'),
('neo_supplier_invoice_accept(uuid,text)','c0d761ed24f0d9c51d76bf9673dbb0e7'),
('current_access_scope()','da8be65110d4568cdb2d9af3eabcc285'),
('folio_post_charge(uuid,text,text,numeric,numeric,numeric,numeric,numeric,text,uuid,text,text,uuid)','ed69c84e7078a7eb266f50c3ac1e3bbc'),
('neo_autopost_on_finalise()','9469da3d6cf2a32bf7a560679501803c'),
('neo_autopost_txn()','e1fc9a640ee70dd2022e8ebd89c9504f'),
('neo_branch_in_scope(uuid)','073af6634a1614993b8a1c0061643270'),
('neo_finance_post_source(text,uuid,boolean)','fc7c4872fa4a2dc361c093cd742584c6'),
('neo_kitchen_route_order_item(uuid)','aa9c7c5ad59f67a20897801096cc8d8c'),
('neo_laundry_posting_invariant()','93a3f507b88f657f0daca7653aad2d64'),
('neo_laundry_stamp_delivered()','7624a831adf91db0c20d61370531eeb4'),
('neo_matching_policy(uuid,uuid)','855e355aa1d4da3708f30e2e1fafc8b9'),
('neo_pos_folio_journal_receipts()','60e18eec2839f26765a6a6457d7b701e'),
('neo_record_posting_receipt(uuid,uuid,text,uuid,text,text,numeric,text,uuid,text,text,date)','b6572ae73812155d3ae2eb08d71878b6'),
('neo_station_consumption_location(uuid,uuid,uuid)','e3c2e5a249ebe8eacdaac1b49e7ff91f'),
('proc_three_way_match(uuid)','35e8a205f2ebdd4b711b12754b8ef9a6'))v(signature,expected))
SELECT jsonb_build_object('diagnostic_version','readiness-laundry-install-v1','read_only',current_setting('transaction_read_only'),
 'code_matches',(SELECT bool_and(coalesce(matches,false)) FROM code),'code',(SELECT jsonb_agg(to_jsonb(c) ORDER BY signature) FROM code c),
 'neighbors_unchanged',(SELECT bool_and(coalesce(unchanged,false)) FROM retained),'retained',(SELECT jsonb_agg(to_jsonb(r) ORDER BY signature) FROM retained r),
 'helpers_private',NOT has_function_privilege('authenticated','public.neo_readiness_org(uuid)','EXECUTE') AND NOT has_function_privilege('anon','public.neo_readiness_org(uuid)','EXECUTE')
   AND NOT has_function_privilege('authenticated','public.neo_laundry_folio_evidence(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE') AND NOT has_function_privilege('anon','public.neo_laundry_folio_evidence(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE'),
 'scope','Code installation only. No historical order, delivery, folio charge, stock movement, payment, journal or business-day close is executed. Fresh laundry intake, non-folio settlement and full business-day certification remain separate gates.') AS diagnostic;
COMMIT;
