
-- Public holidays: use the real leave configuration permission
DROP POLICY IF EXISTS "HR maintains holidays" ON public.public_holidays;
CREATE POLICY "HR maintains holidays" ON public.public_holidays
  FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('hr-leave', 'types.manage'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('hr-leave', 'types.manage'));

-- Employee documents bucket: <organization_id>/<employee_id>/<file>
DROP POLICY IF EXISTS "HR documents: read within organisation" ON storage.objects;
CREATE POLICY "HR documents: read within organisation" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'hr-documents'
    AND (storage.foldername(name))[1] = (current_org_id())::text
    AND (
      has_permission('hr-employees', 'documents.manage')
      OR has_permission('hr-employees', 'directory.view')
      OR EXISTS (
        SELECT 1 FROM public.employees e
         WHERE e.organization_id = current_org_id()
           AND e.profile_id = auth.uid()
           AND (storage.foldername(objects.name))[2] = (e.id)::text
      )
    )
  );

DROP POLICY IF EXISTS "HR documents: written by HR" ON storage.objects;
CREATE POLICY "HR documents: written by HR" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'hr-documents'
    AND (storage.foldername(name))[1] = (current_org_id())::text
    AND has_permission('hr-employees', 'documents.manage')
  );

DROP POLICY IF EXISTS "HR documents: removed by HR" ON storage.objects;
CREATE POLICY "HR documents: removed by HR" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'hr-documents'
    AND (storage.foldername(name))[1] = (current_org_id())::text
    AND has_permission('hr-employees', 'documents.manage')
  );
