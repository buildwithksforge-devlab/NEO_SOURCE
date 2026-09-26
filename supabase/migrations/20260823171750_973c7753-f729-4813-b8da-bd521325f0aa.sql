-- Map a module to the department codes that own it, so department-scoped staff
-- can reach module records that carry no department column of their own.
CREATE OR REPLACE FUNCTION public.neo_module_department_codes(_module text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE lower(coalesce(_module,''))
    WHEN 'delivery'      THEN ARRAY['DELI']
    WHEN 'restaurant'    THEN ARRAY['REST','BAR','KITC','PAST']
    WHEN 'kitchen'       THEN ARRAY['KITC','PAST']
    WHEN 'housekeeping'  THEN ARRAY['HOUS']
    WHEN 'laundry'       THEN ARRAY['LAUN']
    WHEN 'maintenance'   THEN ARRAY['MAIN']
    WHEN 'events'        THEN ARRAY['EVEN']
    WHEN 'procurement'   THEN ARRAY['PROC']
    WHEN 'inventory'     THEN ARRAY['INVE']
    WHEN 'stores'        THEN ARRAY['INVE']
    WHEN 'pms'           THEN ARRAY['FRON']
    WHEN 'frontoffice'   THEN ARRAY['FRON']
    WHEN 'finance'       THEN ARRAY['FINA']
    WHEN 'hr'            THEN ARRAY['HUMA']
    WHEN 'marketing'     THEN ARRAY['MARK']
    WHEN 'security'      THEN ARRAY['SECU']
    ELSE ARRAY[]::text[]
  END;
$$;

CREATE OR REPLACE FUNCTION public.in_my_module_scope(_org uuid, _branch uuid, _module text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(CASE
    WHEN _org IS NULL OR _org <> public.current_org_id() THEN false
    ELSE CASE public.current_access_scope()
      WHEN 'organisation' THEN true
      WHEN 'branch' THEN (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
      WHEN 'technical' THEN false
      ELSE
        (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
        AND EXISTS (
          SELECT 1 FROM public.departments d
          WHERE d.id = ANY (public.current_department_ids())
            AND d.organization_id = _org
            AND upper(coalesce(d.code,'')) = ANY (public.neo_module_department_codes(_module))
        )
    END
  END, false);
$$;

REVOKE ALL ON FUNCTION public.neo_module_department_codes(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.in_my_module_scope(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_module_department_codes(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.in_my_module_scope(uuid, uuid, text) TO authenticated;

DROP POLICY IF EXISTS delivery_orders_staff_read ON public.delivery_orders;
CREATE POLICY delivery_orders_staff_read ON public.delivery_orders
  FOR SELECT TO authenticated
  USING (
    public.is_staff()
    AND public.has_permission('delivery','orders.view')
    AND (
      public.in_my_scope(organization_id, branch_id, NULL, NULL, rider_id, created_by)
      OR public.in_my_module_scope(organization_id, branch_id, 'delivery')
    )
  );

DROP POLICY IF EXISTS delivery_orders_staff_update ON public.delivery_orders;
CREATE POLICY delivery_orders_staff_update ON public.delivery_orders
  FOR UPDATE TO authenticated
  USING (
    public.has_permission('delivery','orders.update')
    AND (
      public.in_my_scope(organization_id, branch_id, NULL, NULL, rider_id, created_by)
      OR public.in_my_module_scope(organization_id, branch_id, 'delivery')
    )
  );