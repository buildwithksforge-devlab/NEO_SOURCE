DROP POLICY IF EXISTS "Avatars: manage own folder" ON storage.objects;
CREATE POLICY "Avatars: manage own folder"
  ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "Avatars: read within organisation" ON storage.objects;
CREATE POLICY "Avatars: read within organisation"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.profiles p
         WHERE p.id::text = (storage.foldername(name))[1]
           AND p.organization_id = public.current_org_id()
      )
      OR EXISTS (
        SELECT 1 FROM public.customers c
         WHERE c.auth_user_id::text = (storage.foldername(name))[1]
           AND c.organization_id = public.current_org_id()
      )
    )
  );