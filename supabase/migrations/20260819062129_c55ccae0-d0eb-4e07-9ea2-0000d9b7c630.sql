CREATE OR REPLACE FUNCTION public.ops_metrics(_branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid := current_org_id();
BEGIN
  IF v_org IS NULL THEN RETURN '{}'::jsonb; END IF;
  RETURN jsonb_build_object(
    'rooms_dirty', (SELECT count(*) FROM rooms WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND housekeeping_status='dirty' AND maintenance_status='operational'),
    'rooms_cleaning', (SELECT count(*) FROM housekeeping_jobs WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND status='in-progress'),
    'rooms_awaiting_inspection', (SELECT count(*) FROM rooms WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND housekeeping_status='awaiting-inspection'),
    'rooms_ready', (SELECT count(*) FROM rooms WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND occupancy_status='vacant' AND maintenance_status='operational' AND housekeeping_status IN ('clean','inspected')),
    'rooms_out_of_order', (SELECT count(*) FROM rooms WHERE organization_id=v_org AND (_branch IS NULL OR branch_id=_branch) AND maintenance_status IN ('out-of-order','out-of-service','under-maintenance')),
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
    'req_awaiting_approval', (SELECT count(*) FROM internal_requisitions WHERE organization_id=v_org AND status IN ('submitted','pending-supervisor')),
    'req_awaiting_stores', (SELECT count(*) FROM internal_requisitions WHERE organization_id=v_org AND status='awaiting-stores'),
    'req_ready_issue', (SELECT count(*) FROM internal_requisitions WHERE organization_id=v_org AND status IN ('ready-for-issue','partially-approved')),
    'req_awaiting_receipt', (SELECT count(*) FROM internal_requisitions WHERE organization_id=v_org AND status IN ('issued','partially-issued','partially-received')),
    'consumption_value', (SELECT COALESCE(sum(value),0) FROM department_consumption WHERE organization_id=v_org AND consumed_on >= CURRENT_DATE - 30)
  );
END $function$;