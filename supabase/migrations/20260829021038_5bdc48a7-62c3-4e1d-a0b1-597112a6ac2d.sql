-- 1. New exact capability: report only, never manage.
INSERT INTO public.permissions (module, action, label)
VALUES ('housekeeping', 'lost-found.report', 'Report a lost or found item')
ON CONFLICT DO NOTHING;

-- 2. Role permission template: housekeeper reports, does not manage.
DELETE FROM public.role_permission_templates
 WHERE module = 'housekeeping'
   AND action = 'lost-found.manage'
   AND template_key IN ('housekeeper', 'room-attendant', 'housekeeping-attendant');

-- 3. Every template that manages Lost & Found also gains the report capability,
--    plus the housekeeper templates above.
INSERT INTO public.role_permission_templates (template_name, template_key, module, action, version)
SELECT DISTINCT t.template_name, t.template_key, 'housekeeping', 'lost-found.report', t.version
  FROM public.role_permission_templates t
 WHERE t.module = 'housekeeping'
   AND (
     t.action = 'lost-found.manage'
     OR t.template_key IN ('housekeeper', 'room-attendant', 'housekeeping-attendant')
   )
   AND NOT EXISTS (
     SELECT 1 FROM public.role_permission_templates x
      WHERE x.template_key = t.template_key
        AND x.module = 'housekeeping'
        AND x.action = 'lost-found.report'
   );

-- 4. Live roles: revoke manage from ordinary housekeeper roles, grant report.
DELETE FROM public.role_permissions rp
 USING public.roles r, public.permissions p
 WHERE rp.role_id = r.id
   AND rp.permission_id = p.id
   AND p.module = 'housekeeping'
   AND p.action = 'lost-found.manage'
   AND lower(r.name) IN ('housekeeper', 'room attendant', 'housekeeping attendant');

INSERT INTO public.role_permissions (role_id, permission_id, organization_id, source)
SELECT r.id, p.id, r.organization_id, 'template'
  FROM public.roles r
  JOIN public.permissions p
    ON p.module = 'housekeeping' AND p.action = 'lost-found.report'
 WHERE r.organization_id IS NOT NULL
   AND (
     lower(r.name) IN ('housekeeper', 'room attendant', 'housekeeping attendant')
     OR EXISTS (
       SELECT 1 FROM public.role_permissions rp2
       JOIN public.permissions p2 ON p2.id = rp2.permission_id
       WHERE rp2.role_id = r.id AND p2.module = 'housekeeping' AND p2.action = 'lost-found.manage'
     )
   )
   AND NOT EXISTS (
     SELECT 1 FROM public.role_permissions rp3
      WHERE rp3.role_id = r.id AND rp3.permission_id = p.id
   );

-- 5. Allow a reporter to file a new entry; editing/closing/deleting is unchanged.
DROP POLICY IF EXISTS lost_found_items_insert ON public.lost_found_items;
CREATE POLICY lost_found_items_insert
  ON public.lost_found_items FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.current_org_id()
    AND (
      public.has_permission('housekeeping', 'create')
      OR public.has_permission('housekeeping', 'edit')
      OR public.has_permission('housekeeping', 'lost-found.manage')
      OR public.has_permission('housekeeping', 'lost-found.report')
      OR public.is_org_admin()
    )
  );