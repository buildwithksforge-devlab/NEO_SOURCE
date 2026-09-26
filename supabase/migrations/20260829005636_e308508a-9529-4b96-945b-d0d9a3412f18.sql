-- ============================================================
-- PHASE 1B — Housekeeping role/permission correction (additive)
-- ============================================================

-- 1) The Housekeeping Manager role was added to the catalogue without any
--    default permission template, so the role compiled to a thin module-wide
--    grant only. Mirror the head-of-department set.
INSERT INTO public.role_permission_templates (template_key, template_name, module, action)
SELECT 'housekeeping-manager', c.role_name, t.module, t.action
FROM public.role_permission_templates t
JOIN public.role_catalogue c ON c.role_key = 'housekeeping-manager'
WHERE t.template_key = 'housekeeping-supervisor'
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permission_templates x
    WHERE x.template_key = 'housekeeping-manager'
      AND x.module = t.module AND x.action = t.action
  );

-- 2) Stores requisition authority is a departmental (manager) authority.
--    An ordinary Housekeeper reports a supply need instead.
DELETE FROM public.role_permission_templates
WHERE template_key = 'housekeeper'
  AND module = 'stores'
  AND action IN ('requisition.create', 'requisition.submit');

DELETE FROM public.role_permissions rp
USING public.roles r, public.permissions p, public.role_catalogue c
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND c.role_key = 'housekeeper'
  AND r.name = c.role_name
  AND p.module = 'stores'
  AND p.action IN ('requisition.create', 'requisition.submit');

-- 3) Housekeeping write authority must be feature-precise.
--    `has_permission(module, action)` treats the feature as a wildcard, so any
--    housekeeping grant of the right action class satisfied it — an ordinary
--    housekeeper's `cleaning.start` / `cleaning.complete` therefore conferred
--    full cleaning-task authority on the table. Ask for the supervisory
--    feature explicitly instead. Lifecycle actions for a housekeeper's own work
--    run through the SECURITY DEFINER routines (hk_start_job, hk_complete_job)
--    and are unaffected.

DROP POLICY IF EXISTS housekeeping_jobs_insert ON public.housekeeping_jobs;
CREATE POLICY housekeeping_jobs_insert ON public.housekeeping_jobs
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.current_org_id()
    AND (
      public.has_permission('housekeeping', 'tasks', 'create')
      OR public.is_org_admin_for(organization_id)
    )
  );

DROP POLICY IF EXISTS housekeeping_jobs_update ON public.housekeeping_jobs;
CREATE POLICY housekeeping_jobs_update ON public.housekeeping_jobs
  FOR UPDATE TO authenticated
  USING (
    (
      public.has_permission('housekeeping', 'tasks', 'edit')
      OR public.has_permission('housekeeping', 'tasks', 'approve')
      OR public.is_org_admin_for(organization_id)
    )
    AND (
      public.in_my_scope(organization_id, branch_id, department_id, NULL::uuid, assignee_id, created_by)
      OR public.is_shared_with_me('housekeeping_job', id)
    )
  )
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS housekeeping_jobs_delete ON public.housekeeping_jobs;
CREATE POLICY housekeeping_jobs_delete ON public.housekeeping_jobs
  FOR DELETE TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      public.has_permission('housekeeping', 'tasks', 'delete')
      OR public.is_org_admin_for(organization_id)
    )
  );

-- Checklist results: a supervisor may record any result; an attendant may
-- record results only on the job assigned to them.
DROP POLICY IF EXISTS housekeeping_job_results_insert ON public.housekeeping_job_results;
CREATE POLICY housekeeping_job_results_insert ON public.housekeeping_job_results
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.housekeeping_jobs j
      WHERE j.id = housekeeping_job_results.job_id
        AND public.in_my_branch_scope(j.organization_id, j.branch_id)
        AND (
          j.assignee_id = auth.uid()
          OR public.has_permission('housekeeping', 'tasks', 'edit')
          OR public.is_org_admin_for(j.organization_id)
        )
    )
  );

DROP POLICY IF EXISTS housekeeping_job_results_update ON public.housekeeping_job_results;
CREATE POLICY housekeeping_job_results_update ON public.housekeeping_job_results
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.housekeeping_jobs j
      WHERE j.id = housekeeping_job_results.job_id
        AND public.in_my_branch_scope(j.organization_id, j.branch_id)
        AND (
          j.assignee_id = auth.uid()
          OR public.has_permission('housekeeping', 'tasks', 'edit')
          OR public.is_org_admin_for(j.organization_id)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.housekeeping_jobs j
      WHERE j.id = housekeeping_job_results.job_id
        AND public.in_my_branch_scope(j.organization_id, j.branch_id)
    )
  );

-- Inspection is a supervisory act.
DROP POLICY IF EXISTS room_inspections_insert ON public.room_inspections;
CREATE POLICY room_inspections_insert ON public.room_inspections
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.current_org_id()
    AND (
      public.has_permission('housekeeping', 'inspections', 'create')
      OR public.has_permission('housekeeping', 'inspections', 'edit')
      OR public.is_org_admin_for(organization_id)
    )
  );

DROP POLICY IF EXISTS room_inspections_update ON public.room_inspections;
CREATE POLICY room_inspections_update ON public.room_inspections
  FOR UPDATE TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      public.has_permission('housekeeping', 'inspections', 'edit')
      OR public.has_permission('housekeeping', 'inspections', 'approve')
      OR public.is_org_admin_for(organization_id)
    )
  )
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS room_inspections_delete ON public.room_inspections;
CREATE POLICY room_inspections_delete ON public.room_inspections
  FOR DELETE TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      public.has_permission('housekeeping', 'inspections', 'delete')
      OR public.is_org_admin_for(organization_id)
    )
  );

-- Deep-clean programme and checklist templates are configuration.
DROP POLICY IF EXISTS deep_cleaning_schedules_insert ON public.deep_cleaning_schedules;
CREATE POLICY deep_cleaning_schedules_insert ON public.deep_cleaning_schedules
  FOR INSERT TO authenticated
  WITH CHECK (
    public.in_my_branch_scope(organization_id, branch_id)
    AND (
      public.has_permission('housekeeping', 'deep-clean', 'create')
      OR public.has_permission('housekeeping', 'deep-clean', 'edit')
      OR public.is_org_admin_for(organization_id)
    )
  );

DROP POLICY IF EXISTS deep_cleaning_schedules_update ON public.deep_cleaning_schedules;
CREATE POLICY deep_cleaning_schedules_update ON public.deep_cleaning_schedules
  FOR UPDATE TO authenticated
  USING (
    public.in_my_branch_scope(organization_id, branch_id)
    AND (
      public.has_permission('housekeeping', 'deep-clean', 'edit')
      OR public.has_permission('housekeeping', 'deep-clean', 'approve')
      OR public.is_org_admin_for(organization_id)
    )
  )
  WITH CHECK (public.in_my_branch_scope(organization_id, branch_id));

DROP POLICY IF EXISTS housekeeping_checklist_templates_insert ON public.housekeeping_checklist_templates;
CREATE POLICY housekeeping_checklist_templates_insert ON public.housekeeping_checklist_templates
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.current_org_id()
    AND (
      public.has_permission('housekeeping', 'checklists', 'create')
      OR public.has_permission('housekeeping', 'checklists', 'edit')
      OR public.is_org_admin_for(organization_id)
    )
  );

DROP POLICY IF EXISTS housekeeping_checklist_templates_update ON public.housekeeping_checklist_templates;
CREATE POLICY housekeeping_checklist_templates_update ON public.housekeeping_checklist_templates
  FOR UPDATE TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      public.has_permission('housekeeping', 'checklists', 'edit')
      OR public.has_permission('housekeeping', 'checklists', 'approve')
      OR public.is_org_admin_for(organization_id)
    )
  )
  WITH CHECK (organization_id = public.current_org_id());

-- 4) Re-provision every workspace so the corrected defaults land on the
--    existing roles. Provisioning only adds catalogue grants; it never removes
--    a role, a user assignment or an individually granted permission.
DO $do$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM public.organizations LOOP
    PERFORM public.provision_catalogue_roles(o.id);
  END LOOP;
END;
$do$;