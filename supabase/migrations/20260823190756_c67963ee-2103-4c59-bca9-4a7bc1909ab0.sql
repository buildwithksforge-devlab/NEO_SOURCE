DROP POLICY IF EXISTS report_schedules_select ON public.report_schedules;
CREATE POLICY report_schedules_select ON public.report_schedules FOR SELECT TO authenticated USING (
  organization_id = public.current_org_id()
  AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('analytics','view') OR public.has_permission('ai','view'))
);
DROP POLICY IF EXISTS report_schedules_insert ON public.report_schedules;
CREATE POLICY report_schedules_insert ON public.report_schedules FOR INSERT TO authenticated WITH CHECK (
  organization_id = public.current_org_id()
  AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('analytics','create') OR public.has_permission('analytics','edit'))
);
DROP POLICY IF EXISTS report_schedules_update ON public.report_schedules;
CREATE POLICY report_schedules_update ON public.report_schedules FOR UPDATE TO authenticated USING (
  organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('analytics','edit'))
) WITH CHECK (organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id));

DROP POLICY IF EXISTS report_runs_select ON public.report_runs;
CREATE POLICY report_runs_select ON public.report_runs FOR SELECT TO authenticated USING (
  organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('analytics','view') OR public.has_permission('ai','view'))
);
DROP POLICY IF EXISTS report_runs_insert ON public.report_runs;
CREATE POLICY report_runs_insert ON public.report_runs FOR INSERT TO authenticated WITH CHECK (
  organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('analytics','create') OR public.has_permission('analytics','edit'))
);
DROP POLICY IF EXISTS report_runs_update ON public.report_runs;
CREATE POLICY report_runs_update ON public.report_runs FOR UPDATE TO authenticated USING (
  organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('analytics','edit'))
) WITH CHECK (organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id));

DROP POLICY IF EXISTS generated_reports_select ON public.generated_reports;
CREATE POLICY generated_reports_select ON public.generated_reports FOR SELECT TO authenticated USING (
  organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('analytics','view') OR public.has_permission('ai','view'))
);
DROP POLICY IF EXISTS generated_reports_insert ON public.generated_reports;
CREATE POLICY generated_reports_insert ON public.generated_reports FOR INSERT TO authenticated WITH CHECK (
  organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('analytics','create') OR public.has_permission('analytics','edit'))
);
DROP POLICY IF EXISTS generated_reports_update ON public.generated_reports;
CREATE POLICY generated_reports_update ON public.generated_reports FOR UPDATE TO authenticated USING (
  organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('analytics','edit'))
) WITH CHECK (organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id));

DROP POLICY IF EXISTS ai_recommendations_select ON public.ai_recommendations;
CREATE POLICY ai_recommendations_select ON public.ai_recommendations FOR SELECT TO authenticated USING (
  organization_id = public.current_org_id()
  AND public.in_my_branch_scope(organization_id, branch_id)
  AND (department_id IS NULL OR public.current_access_scope() = 'organisation' OR department_id = ANY(public.current_department_ids()))
  AND (public.is_org_admin() OR public.has_permission('analytics','view') OR public.has_permission('ai','view'))
);
DROP POLICY IF EXISTS ai_recommendations_insert ON public.ai_recommendations;
CREATE POLICY ai_recommendations_insert ON public.ai_recommendations FOR INSERT TO authenticated WITH CHECK (
  organization_id = public.current_org_id()
  AND public.in_my_branch_scope(organization_id, branch_id)
  AND (department_id IS NULL OR public.current_access_scope() = 'organisation' OR department_id = ANY(public.current_department_ids()))
  AND (public.is_org_admin() OR public.has_permission('analytics','create') OR public.has_permission('analytics','edit'))
);
DROP POLICY IF EXISTS ai_recommendations_update ON public.ai_recommendations;
CREATE POLICY ai_recommendations_update ON public.ai_recommendations FOR UPDATE TO authenticated USING (
  organization_id = public.current_org_id()
  AND public.in_my_branch_scope(organization_id, branch_id)
  AND (department_id IS NULL OR public.current_access_scope() = 'organisation' OR department_id = ANY(public.current_department_ids()))
  AND (public.is_org_admin() OR public.has_permission('analytics','edit'))
) WITH CHECK (
  organization_id = public.current_org_id()
  AND public.in_my_branch_scope(organization_id, branch_id)
  AND (department_id IS NULL OR public.current_access_scope() = 'organisation' OR department_id = ANY(public.current_department_ids()))
);

DROP POLICY IF EXISTS "ai insights read" ON public.ai_insights;
CREATE POLICY "ai insights read" ON public.ai_insights FOR SELECT TO authenticated USING (
  organization_id = public.current_org_id()
  AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('ai','view'))
);
DROP POLICY IF EXISTS "ai insights insert" ON public.ai_insights;
CREATE POLICY "ai insights insert" ON public.ai_insights FOR INSERT TO authenticated WITH CHECK (
  organization_id = public.current_org_id() AND created_by = auth.uid()
  AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('ai','create'))
);

DROP POLICY IF EXISTS risk_alerts_select ON public.risk_alerts;
CREATE POLICY risk_alerts_select ON public.risk_alerts FOR SELECT TO authenticated USING (
  organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('analytics','view') OR public.has_permission('ai','view'))
);
DROP POLICY IF EXISTS risk_alerts_insert ON public.risk_alerts;
CREATE POLICY risk_alerts_insert ON public.risk_alerts FOR INSERT TO authenticated WITH CHECK (
  organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('analytics','create') OR public.has_permission('analytics','edit'))
);
DROP POLICY IF EXISTS risk_alerts_update ON public.risk_alerts;
CREATE POLICY risk_alerts_update ON public.risk_alerts FOR UPDATE TO authenticated USING (
  organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id)
  AND (public.is_org_admin() OR public.has_permission('analytics','edit'))
) WITH CHECK (organization_id = public.current_org_id() AND public.in_my_branch_scope(organization_id, branch_id));