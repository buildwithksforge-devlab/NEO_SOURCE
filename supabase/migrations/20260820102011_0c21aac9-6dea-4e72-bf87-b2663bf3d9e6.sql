-- Stage 2 scope enforcement: rooms, front office, housekeeping, maintenance, laundry
-- Rooms & room types (property reference data)
DROP POLICY IF EXISTS staff_read_rooms ON public.rooms;
CREATE POLICY staff_read_rooms ON public.rooms FOR SELECT TO authenticated
  USING (public.in_my_branch_scope(organization_id, branch_id));
DROP POLICY IF EXISTS staff_update_rooms ON public.rooms;
CREATE POLICY staff_update_rooms ON public.rooms FOR UPDATE TO authenticated
  USING (public.in_my_branch_scope(organization_id, branch_id)
         AND (public.has_permission('pms','write') OR public.has_permission('housekeeping','edit') OR public.is_org_admin()))
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id));
DROP POLICY IF EXISTS staff_insert_rooms ON public.rooms;
CREATE POLICY staff_insert_rooms ON public.rooms FOR INSERT TO authenticated
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id) AND public.has_permission('pms','write'));

DROP POLICY IF EXISTS staff_read_room_types ON public.room_types;
CREATE POLICY staff_read_room_types ON public.room_types FOR SELECT TO authenticated
  USING (public.in_my_branch_scope(organization_id, branch_id));
DROP POLICY IF EXISTS staff_update_room_types ON public.room_types;
CREATE POLICY staff_update_room_types ON public.room_types FOR UPDATE TO authenticated
  USING (public.in_my_branch_scope(organization_id, branch_id) AND public.has_permission('pms','write'))
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id));
DROP POLICY IF EXISTS staff_insert_room_types ON public.room_types;
CREATE POLICY staff_insert_room_types ON public.room_types FOR INSERT TO authenticated
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id) AND public.has_permission('pms','write'));

-- Room assignments
DROP POLICY IF EXISTS staff_read_room_assignments ON public.room_assignments;
CREATE POLICY staff_read_room_assignments ON public.room_assignments FOR SELECT TO authenticated
  USING (public.in_my_branch_scope(organization_id, branch_id));
DROP POLICY IF EXISTS staff_update_room_assignments ON public.room_assignments;
CREATE POLICY staff_update_room_assignments ON public.room_assignments FOR UPDATE TO authenticated
  USING (public.in_my_branch_scope(organization_id, branch_id) AND public.has_permission('pms','write'))
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id));
DROP POLICY IF EXISTS staff_insert_room_assignments ON public.room_assignments;
CREATE POLICY staff_insert_room_assignments ON public.room_assignments FOR INSERT TO authenticated
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id) AND public.has_permission('pms','write'));

-- Reservations / front office
DROP POLICY IF EXISTS staff_read_reservations ON public.reservations;
CREATE POLICY staff_read_reservations ON public.reservations FOR SELECT TO authenticated
  USING (public.in_my_branch_scope(organization_id, branch_id) OR created_by = auth.uid());
DROP POLICY IF EXISTS staff_update_reservations ON public.reservations;
CREATE POLICY staff_update_reservations ON public.reservations FOR UPDATE TO authenticated
  USING (public.in_my_branch_scope(organization_id, branch_id) AND public.has_permission('pms','write'))
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id));
DROP POLICY IF EXISTS staff_insert_reservations ON public.reservations;
CREATE POLICY staff_insert_reservations ON public.reservations FOR INSERT TO authenticated
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id) AND public.has_permission('pms','write'));

-- Housekeeping: deep cleaning + job results (results follow their parent job)
DROP POLICY IF EXISTS deep_cleaning_schedules_select ON public.deep_cleaning_schedules;
CREATE POLICY deep_cleaning_schedules_select ON public.deep_cleaning_schedules FOR SELECT TO authenticated
  USING (public.in_my_branch_scope(organization_id, branch_id) OR created_by = auth.uid());
DROP POLICY IF EXISTS deep_cleaning_schedules_update ON public.deep_cleaning_schedules;
CREATE POLICY deep_cleaning_schedules_update ON public.deep_cleaning_schedules FOR UPDATE TO authenticated
  USING (public.in_my_branch_scope(organization_id, branch_id)
         AND (public.has_permission('housekeeping','edit') OR public.has_permission('housekeeping','approve') OR public.is_org_admin()))
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id));
DROP POLICY IF EXISTS deep_cleaning_schedules_insert ON public.deep_cleaning_schedules;
CREATE POLICY deep_cleaning_schedules_insert ON public.deep_cleaning_schedules FOR INSERT TO authenticated
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id)
              AND (public.has_permission('housekeeping','create') OR public.has_permission('housekeeping','edit') OR public.is_org_admin()));

DROP POLICY IF EXISTS housekeeping_job_results_select ON public.housekeeping_job_results;
CREATE POLICY housekeeping_job_results_select ON public.housekeeping_job_results FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.housekeeping_jobs j WHERE j.id = job_id));
DROP POLICY IF EXISTS housekeeping_job_results_update ON public.housekeeping_job_results;
CREATE POLICY housekeeping_job_results_update ON public.housekeeping_job_results FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.housekeeping_jobs j WHERE j.id = job_id)
         AND (public.has_permission('housekeeping','edit') OR public.has_permission('housekeeping','approve') OR public.is_org_admin()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.housekeeping_jobs j WHERE j.id = job_id));
DROP POLICY IF EXISTS housekeeping_job_results_insert ON public.housekeeping_job_results;
CREATE POLICY housekeeping_job_results_insert ON public.housekeeping_job_results FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.housekeeping_jobs j WHERE j.id = job_id)
              AND (public.has_permission('housekeeping','create') OR public.has_permission('housekeeping','edit') OR public.is_org_admin()));

-- Maintenance: assets + work order writes follow the same scope as reads
DROP POLICY IF EXISTS assets_select ON public.assets;
CREATE POLICY assets_select ON public.assets FOR SELECT TO authenticated
  USING (public.in_my_scope(organization_id, branch_id, department_id, NULL::uuid, NULL::uuid, created_by));
DROP POLICY IF EXISTS assets_update ON public.assets;
CREATE POLICY assets_update ON public.assets FOR UPDATE TO authenticated
  USING (public.in_my_scope(organization_id, branch_id, department_id, NULL::uuid, NULL::uuid, created_by)
         AND (public.has_permission('maintenance','edit') OR public.has_permission('maintenance','approve') OR public.is_org_admin()))
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id));
DROP POLICY IF EXISTS assets_insert ON public.assets;
CREATE POLICY assets_insert ON public.assets FOR INSERT TO authenticated
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id)
              AND (public.has_permission('maintenance','create') OR public.has_permission('maintenance','edit') OR public.is_org_admin()));

DROP POLICY IF EXISTS maintenance_work_orders_update ON public.maintenance_work_orders;
CREATE POLICY maintenance_work_orders_update ON public.maintenance_work_orders FOR UPDATE TO authenticated
  USING ((public.in_my_scope(organization_id, branch_id, requesting_department_id, NULL::uuid, assigned_to, created_by)
          OR requested_by = auth.uid()
          OR public.is_shared_with_me('maintenance_work_order', id))
         AND (public.has_permission('maintenance','edit') OR public.has_permission('maintenance','approve') OR public.is_org_admin()))
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id));
DROP POLICY IF EXISTS maintenance_work_orders_insert ON public.maintenance_work_orders;
CREATE POLICY maintenance_work_orders_insert ON public.maintenance_work_orders FOR INSERT TO authenticated
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id)
              AND (public.has_permission('maintenance','create') OR public.has_permission('maintenance','edit') OR public.is_org_admin()));

-- Laundry: orders scoped to property or own work; items follow their order
DROP POLICY IF EXISTS guest_laundry_orders_select ON public.guest_laundry_orders;
CREATE POLICY guest_laundry_orders_select ON public.guest_laundry_orders FOR SELECT TO authenticated
  USING (public.in_my_branch_scope(organization_id, branch_id)
         OR assignee_id = auth.uid() OR created_by = auth.uid());
DROP POLICY IF EXISTS guest_laundry_orders_update ON public.guest_laundry_orders;
CREATE POLICY guest_laundry_orders_update ON public.guest_laundry_orders FOR UPDATE TO authenticated
  USING ((public.in_my_branch_scope(organization_id, branch_id) OR assignee_id = auth.uid() OR created_by = auth.uid())
         AND (public.has_permission('laundry','edit') OR public.has_permission('laundry','approve') OR public.is_org_admin()))
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id));
DROP POLICY IF EXISTS guest_laundry_orders_insert ON public.guest_laundry_orders;
CREATE POLICY guest_laundry_orders_insert ON public.guest_laundry_orders FOR INSERT TO authenticated
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id)
              AND (public.has_permission('laundry','create') OR public.has_permission('laundry','edit') OR public.is_org_admin()));

DROP POLICY IF EXISTS guest_laundry_items_select ON public.guest_laundry_items;
CREATE POLICY guest_laundry_items_select ON public.guest_laundry_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.guest_laundry_orders o WHERE o.id = order_id));
DROP POLICY IF EXISTS guest_laundry_items_update ON public.guest_laundry_items;
CREATE POLICY guest_laundry_items_update ON public.guest_laundry_items FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.guest_laundry_orders o WHERE o.id = order_id)
         AND (public.has_permission('laundry','edit') OR public.has_permission('laundry','approve') OR public.is_org_admin()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.guest_laundry_orders o WHERE o.id = order_id));
DROP POLICY IF EXISTS guest_laundry_items_insert ON public.guest_laundry_items;
CREATE POLICY guest_laundry_items_insert ON public.guest_laundry_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.guest_laundry_orders o WHERE o.id = order_id)
              AND (public.has_permission('laundry','create') OR public.has_permission('laundry','edit') OR public.is_org_admin()));