-- 1. Stores capabilities that the screens demand but the catalogue never held.
INSERT INTO public.permissions (module, feature, action, label)
SELECT v.module, v.feature, v.action, v.label
FROM (VALUES
  ('stores','requisitions','view','Stores — view department requisitions'),
  ('stores','requisitions','edit','Stores — edit department requisitions'),
  ('stores','requisitions','approve','Stores — approve department requisitions'),
  ('stores','requisitions','create','Stores — raise a department requisition'),
  ('stores','requisitions','print','Stores — print a requisition'),
  ('stores','requisitions','export','Stores — export requisitions'),
  ('stores','counts','view','Stores — view stock counts'),
  ('stores','counts','create','Stores — start a stock count'),
  ('stores','counts','edit','Stores — record count lines'),
  ('stores','counts','approve','Stores — approve a count variance'),
  ('stores','counts','export','Stores — export stock counts'),
  ('stores','tasks','view','Stores — view stores tasks'),
  ('stores','tasks','create','Stores — create a stores task'),
  ('stores','tasks','edit','Stores — update a stores task')
) AS v(module, feature, action, label)
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions p
  WHERE p.module = v.module AND p.feature = v.feature AND p.action = v.action
);

-- 2. The store roles are the ones who actually run that queue.
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT v.role_key, 'stores', v.feature, v.action
FROM (VALUES
  ('storekeeper','requisitions','view'),
  ('storekeeper','requisitions','edit'),
  ('storekeeper','requisitions','approve'),
  ('storekeeper','requisitions','print'),
  ('storekeeper','requisitions','export'),
  ('storekeeper','counts','view'),
  ('storekeeper','counts','create'),
  ('storekeeper','counts','edit'),
  ('storekeeper','counts','export'),
  ('storekeeper','tasks','view'),
  ('storekeeper','tasks','create'),
  ('storekeeper','tasks','edit'),
  ('stores_manager','requisitions','view'),
  ('stores_manager','requisitions','edit'),
  ('stores_manager','requisitions','approve'),
  ('stores_manager','requisitions','create'),
  ('stores_manager','requisitions','print'),
  ('stores_manager','requisitions','export'),
  ('stores_manager','counts','view'),
  ('stores_manager','counts','create'),
  ('stores_manager','counts','edit'),
  ('stores_manager','counts','approve'),
  ('stores_manager','counts','export'),
  ('stores_manager','tasks','view'),
  ('stores_manager','tasks','create'),
  ('stores_manager','tasks','edit')
) AS v(role_key, feature, action)
WHERE EXISTS (SELECT 1 FROM public.role_feature_templates t WHERE t.role_key = v.role_key)
  AND NOT EXISTS (
    SELECT 1 FROM public.role_feature_templates t
    WHERE t.role_key = v.role_key AND t.module = 'stores'
      AND t.feature = v.feature AND t.action = v.action
  );

-- 3. Room figures read the canonical room state, not the legacy status column.
CREATE OR REPLACE FUNCTION public.ops_metrics(_branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid := current_org_id();
BEGIN
  IF v_org IS NULL THEN RETURN '{}'::jsonb; END IF;
  RETURN (
    WITH rs AS (
      SELECT * FROM public.ops_room_state(_branch) s WHERE s.organization_id = v_org
    )
    SELECT jsonb_build_object(
      'rooms_dirty', (SELECT count(*) FROM rs WHERE rs.housekeeping_state = 'dirty' AND rs.maintenance_status = 'operational'),
      'rooms_cleaning', (SELECT count(*) FROM rs WHERE rs.housekeeping_state IN ('cleaning_queued','cleaning_in_progress')),
      'rooms_awaiting_inspection', (SELECT count(*) FROM rs WHERE rs.housekeeping_state IN ('awaiting_inspection','rework_required')),
      'rooms_ready', (SELECT count(*) FROM rs WHERE rs.readiness_state = 'ready'),
      'rooms_sellable_now', (SELECT count(*) FROM rs WHERE rs.sellable_now),
      'rooms_out_of_order', (SELECT count(*) FROM rs WHERE rs.maintenance_status IN ('out-of-order','out-of-service','under-maintenance')),
      'jobs_open', (SELECT count(*) FROM housekeeping_jobs WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND status NOT IN ('completed','cancelled')),
      'jobs_rework', (SELECT count(*) FROM housekeeping_jobs WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND status='rework'),
      'failed_inspections', (SELECT count(*) FROM room_inspections WHERE organization_id=v_org AND result IN ('failed','reinspection-required')),
      'lost_found_open', (SELECT count(*) FROM lost_found_items WHERE organization_id=v_org AND status IN ('reported','in-custody','potential-owner-identified','contacted')),
      'laundry_active', (SELECT count(*) FROM guest_laundry_orders WHERE organization_id=v_org AND status NOT IN ('completed','cancelled')),
      'laundry_unposted', (SELECT count(*) FROM guest_laundry_orders WHERE organization_id=v_org AND status IN ('delivered','completed') AND posting_status<>'posted'),
      'laundry_revenue', (SELECT COALESCE(sum(total),0) FROM guest_laundry_orders WHERE organization_id=v_org AND posting_status='posted'),
      'linen_incidents', (SELECT count(*) FROM linen_incidents WHERE organization_id=v_org AND status='reported'),
      'wo_new', (SELECT count(*) FROM maintenance_work_orders WHERE organization_id=v_org AND status='new'),
      'wo_open', (SELECT count(*) FROM maintenance_work_orders WHERE organization_id=v_org AND status NOT IN ('closed','cancelled')),
      'wo_emergency', (SELECT count(*) FROM maintenance_work_orders WHERE organization_id=v_org AND priority='emergency' AND status NOT IN ('closed','cancelled')),
      'wo_waiting_parts', (SELECT count(*) FROM maintenance_work_orders WHERE organization_id=v_org AND status IN ('waiting-parts','waiting-supplier')),
      'wo_cost', (SELECT COALESCE(sum(actual_cost),0) FROM maintenance_work_orders WHERE organization_id=v_org),
      'pm_due', (SELECT count(*) FROM preventive_maintenance_plans WHERE organization_id=v_org AND status='active' AND next_due_date <= CURRENT_DATE + 14),
      'assets_total', (SELECT count(*) FROM assets WHERE organization_id=v_org),
      'assets_alert', (SELECT count(*) FROM assets WHERE organization_id=v_org AND (status IN ('under-maintenance','out-of-service') OR (warranty_expiry IS NOT NULL AND warranty_expiry <= CURRENT_DATE + 60))),
      'req_awaiting_approval', (SELECT count(*) FROM internal_requisitions WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND status IN ('submitted','pending-supervisor')),
      'req_awaiting_stores', (SELECT count(*) FROM internal_requisitions WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND status='awaiting-stores'),
      'req_ready_issue', (SELECT count(*) FROM internal_requisitions WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND status IN ('ready-for-issue','partially-approved')),
      'req_awaiting_receipt', (SELECT count(*) FROM internal_requisitions WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND status IN ('issued','partially-issued','partially-received')),
      'needs_open', (SELECT count(*) FROM department_stock_needs WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND status IN ('reported','acknowledged','pending')),
      'consumption_value', (SELECT COALESCE(sum(value),0) FROM department_consumption WHERE organization_id=v_org AND consumed_on >= CURRENT_DATE - 30)
    )
  );
END $function$;

-- 4. Recompile every organisation's grants from the corrected templates.
DO $$
DECLARE o uuid;
BEGIN
  FOR o IN SELECT id FROM public.organizations LOOP
    PERFORM public.neo_apply_feature_templates(o);
  END LOOP;
END $$;