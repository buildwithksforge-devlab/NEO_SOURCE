-- public.delivery_orders (delivery_orders_customer_read)
(customer_id = my_customer_id())

-- public.delivery_orders (delivery_orders_rider_read)
((rider_id = my_rider_id()) AND ((dispatch_status <> ALL (ARRAY['delivered'::text, 'delivery-failed'::text, 'returned'::text])) OR (updated_at > (now() - '24:00:00'::interval))))

-- public.delivery_orders (delivery_orders_staff_read)
(is_staff() AND has_permission('delivery'::text, 'orders.view'::text) AND in_my_scope(organization_id, branch_id, NULL::uuid, NULL::uuid, rider_id, NULL::uuid))

-- public.delivery_orders (delivery_orders_staff_update)
(has_permission('delivery'::text, 'orders.update'::text) AND in_my_scope(organization_id, branch_id, NULL::uuid, NULL::uuid, rider_id, NULL::uuid))

-- public.housekeeping_jobs (housekeeping_jobs_delete)
((organization_id = current_org_id()) AND (has_permission('housekeeping'::text, 'tasks'::text, 'delete'::text) OR is_org_admin_for(organization_id)))

-- public.housekeeping_jobs (housekeeping_jobs_insert)
((organization_id = current_org_id()) AND (has_permission('housekeeping'::text, 'tasks'::text, 'create'::text) OR is_org_admin_for(organization_id)))

-- public.housekeeping_jobs (housekeeping_jobs_select)
(in_my_scope(organization_id, branch_id, department_id, NULL::uuid, assignee_id, created_by) OR is_shared_with_me('housekeeping_job'::text, id))

-- public.housekeeping_jobs (housekeeping_jobs_update)
((has_permission('housekeeping'::text, 'tasks'::text, 'edit'::text) OR has_permission('housekeeping'::text, 'tasks'::text, 'approve'::text) OR is_org_admin_for(organization_id)) AND (in_my_scope(organization_id, branch_id, department_id, NULL::uuid, assignee_id, created_by) OR is_shared_with_me('housekeeping_job'::text, id)))

-- public.pos_order_items (pos_order_items_select)
(EXISTS ( SELECT 1
   FROM pos_orders o
  WHERE ((o.id = pos_order_items.order_id) AND (in_my_scope(o.organization_id, o.branch_id, o.department_id, o.station_id, o.waiter_id, o.created_by) OR is_shared_with_me('pos_order'::text, o.id)))))

-- public.pos_order_items (pos_order_items_write)
((has_permission('pos'::text, 'orders.create'::text) OR has_permission('pos'::text, 'kds.view'::text)) AND (EXISTS ( SELECT 1
   FROM pos_orders o
  WHERE ((o.id = pos_order_items.order_id) AND (in_my_scope(o.organization_id, o.branch_id, o.department_id, o.station_id, o.waiter_id, o.created_by) OR is_shared_with_me('pos_order'::text, o.id))))))

-- public.pos_orders (pos_orders_delete)
((organization_id = current_org_id()) AND is_org_admin())

-- public.pos_orders (pos_orders_insert)


-- public.pos_orders (pos_orders_select)
(in_my_scope(organization_id, branch_id, department_id, station_id, waiter_id, created_by) OR is_shared_with_me('pos_order'::text, id))

-- public.pos_orders (pos_orders_update)
(has_permission('pos'::text, 'orders.create'::text) AND (in_my_scope(organization_id, branch_id, department_id, station_id, waiter_id, created_by) OR is_shared_with_me('pos_order'::text, id)))

-- public.rider_shifts (rider_shifts_read)
((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND (has_permission('delivery'::text, 'dispatch.view'::text) OR has_permission('delivery'::text, 'riders.manage'::text) OR (EXISTS ( SELECT 1
   FROM rider_profiles r
  WHERE ((r.id = rider_shifts.rider_id) AND (r.profile_id = auth.uid()))))))

-- public.rider_shifts (rider_shifts_write)
((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('delivery'::text, 'riders.manage'::text))

-- in_my_scope
CREATE OR REPLACE FUNCTION public.in_my_scope(_org uuid, _branch uuid, _department uuid, _station uuid, _assigned_user uuid, _created_by uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN _org IS NULL OR _org <> public.current_org_id() THEN false
    ELSE CASE public.current_access_scope()
      WHEN 'organisation' THEN true
      WHEN 'branch' THEN (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
      WHEN 'department' THEN
        (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
        AND (
          _department = ANY (public.current_department_ids())
          OR _station = ANY (public.current_station_ids())
          OR _assigned_user = auth.uid()
          OR _created_by = auth.uid()
          OR public.supervises_user(_assigned_user)
        )
      WHEN 'team' THEN
        (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
        AND (
          _station = ANY (public.current_station_ids())
          OR _assigned_user = auth.uid()
          OR _created_by = auth.uid()
          OR public.supervises_user(_assigned_user)
        )
      WHEN 'technical' THEN false
      ELSE (_assigned_user = auth.uid() OR _created_by = auth.uid())
    END
  END;
$function$

-- kitchen_tickets policies

