-- Owner / platform-administrator separation for configuration data.
-- A technical (platform/system administrator) account manages configuration
-- but is deliberately kept out of guest-operational records.
CREATE OR REPLACE FUNCTION public.in_my_config_scope(_org uuid, _branch uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
    WHEN _org IS NULL OR _org <> public.current_org_id() THEN false
    WHEN public.current_access_scope() = 'technical' THEN public.is_org_admin()
    ELSE public.in_my_branch_scope(_org, _branch)
  END;
$$;
REVOKE EXECUTE ON FUNCTION public.in_my_config_scope(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.in_my_config_scope(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS staff_read_rooms ON public.rooms;
CREATE POLICY staff_read_rooms ON public.rooms FOR SELECT TO authenticated
  USING (public.in_my_config_scope(organization_id, branch_id));
DROP POLICY IF EXISTS staff_update_rooms ON public.rooms;
CREATE POLICY staff_update_rooms ON public.rooms FOR UPDATE TO authenticated
  USING (public.in_my_config_scope(organization_id, branch_id)
         AND (public.has_permission('pms','write') OR public.has_permission('housekeeping','edit') OR public.is_org_admin()))
  WITH CHECK (public.in_my_config_scope(organization_id, branch_id));
DROP POLICY IF EXISTS staff_insert_rooms ON public.rooms;
CREATE POLICY staff_insert_rooms ON public.rooms FOR INSERT TO authenticated
  WITH CHECK (public.in_my_config_scope(organization_id, branch_id)
              AND (public.has_permission('pms','write') OR public.is_org_admin()));

DROP POLICY IF EXISTS staff_read_room_types ON public.room_types;
CREATE POLICY staff_read_room_types ON public.room_types FOR SELECT TO authenticated
  USING (public.in_my_config_scope(organization_id, branch_id));
DROP POLICY IF EXISTS staff_update_room_types ON public.room_types;
CREATE POLICY staff_update_room_types ON public.room_types FOR UPDATE TO authenticated
  USING (public.in_my_config_scope(organization_id, branch_id)
         AND (public.has_permission('pms','write') OR public.is_org_admin()))
  WITH CHECK (public.in_my_config_scope(organization_id, branch_id));
DROP POLICY IF EXISTS staff_insert_room_types ON public.room_types;
CREATE POLICY staff_insert_room_types ON public.room_types FOR INSERT TO authenticated
  WITH CHECK (public.in_my_config_scope(organization_id, branch_id)
              AND (public.has_permission('pms','write') OR public.is_org_admin()));

DROP POLICY IF EXISTS assets_select ON public.assets;
CREATE POLICY assets_select ON public.assets FOR SELECT TO authenticated
  USING (public.in_my_config_scope(organization_id, branch_id)
         OR public.in_my_scope(organization_id, branch_id, department_id, NULL::uuid, NULL::uuid, created_by));
DROP POLICY IF EXISTS assets_insert ON public.assets;
CREATE POLICY assets_insert ON public.assets FOR INSERT TO authenticated
  WITH CHECK (public.in_my_config_scope(organization_id, branch_id)
              AND (public.has_permission('maintenance','create') OR public.has_permission('maintenance','edit') OR public.is_org_admin()));

DROP POLICY IF EXISTS staff_read_room_assignments ON public.room_assignments;
CREATE POLICY staff_read_room_assignments ON public.room_assignments FOR SELECT TO authenticated
  USING (public.in_my_config_scope(organization_id, branch_id));