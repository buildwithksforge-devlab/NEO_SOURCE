DROP POLICY IF EXISTS "attendance update" ON public.attendance_records;
CREATE POLICY "attendance update" ON public.attendance_records
FOR UPDATE
USING (
  organization_id = current_org_id()
  AND (
    (hr_is_self(employee_id) AND status = ANY (ARRAY['in_progress'::text,'pending_review'::text,'incomplete'::text]))
    OR has_permission('hr-attendance'::text, 'correct'::text)
  )
)
WITH CHECK (organization_id = current_org_id());