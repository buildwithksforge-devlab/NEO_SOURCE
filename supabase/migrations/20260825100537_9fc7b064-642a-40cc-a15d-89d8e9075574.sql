DROP POLICY IF EXISTS "Menu images: read within organisation" ON storage.objects;
CREATE POLICY "Menu images: read within organisation"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'menu-images'
  AND (storage.foldername(name))[1] = public.current_org_id()::text
);

DROP POLICY IF EXISTS "Menu images: managed by menu editors" ON storage.objects;
CREATE POLICY "Menu images: managed by menu editors"
ON storage.objects FOR ALL TO authenticated
USING (
  bucket_id = 'menu-images'
  AND (storage.foldername(name))[1] = public.current_org_id()::text
  AND (public.has_permission('restaurant','menu','edit') OR public.has_permission('restaurant','menu','create'))
)
WITH CHECK (
  bucket_id = 'menu-images'
  AND (storage.foldername(name))[1] = public.current_org_id()::text
  AND (public.has_permission('restaurant','menu','edit') OR public.has_permission('restaurant','menu','create'))
);