-- ============ Guest documents ============
ALTER TABLE public.customer_documents
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS file_size bigint,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS customer_documents_customer_idx ON public.customer_documents (customer_id, created_at DESC);

DROP POLICY IF EXISTS "documents restricted" ON public.customer_documents;

CREATE POLICY "guest documents readable by authorised staff or the guest"
  ON public.customer_documents FOR SELECT TO authenticated
  USING (
    (organization_id = public.current_org_id()
      AND public.has_permission('crm','documents','view'))
    OR EXISTS (SELECT 1 FROM public.customers c
               WHERE c.id = customer_documents.customer_id AND c.auth_user_id = auth.uid())
  );

CREATE POLICY "guest documents written by authorised staff"
  ON public.customer_documents FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
              AND public.has_permission('crm','documents','create'));

CREATE POLICY "guest documents edited by authorised staff"
  ON public.customer_documents FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('crm','documents','edit'))
  WITH CHECK (organization_id = public.current_org_id());

CREATE POLICY "guest documents removed by authorised staff"
  ON public.customer_documents FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('crm','documents','delete'));

CREATE TABLE IF NOT EXISTS public.customer_document_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES public.customer_documents(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.customer_document_access_log TO authenticated;
GRANT ALL ON public.customer_document_access_log TO service_role;
ALTER TABLE public.customer_document_access_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document access log readable by authorised staff"
  ON public.customer_document_access_log FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('crm','documents','view'));

CREATE POLICY "document access log written by the actor"
  ON public.customer_document_access_log FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND actor_id = auth.uid());

-- Private bucket policies: <organization_id>/<customer_id>/<file>
CREATE POLICY "Guest documents: read within organisation"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'guest-documents'
    AND (storage.foldername(name))[1] = (public.current_org_id())::text
    AND (
      public.has_permission('crm','documents','view')
      OR EXISTS (SELECT 1 FROM public.customers c
                 WHERE c.auth_user_id = auth.uid()
                   AND (storage.foldername(objects.name))[2] = (c.id)::text)
    )
  );

CREATE POLICY "Guest documents: written by authorised staff"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'guest-documents'
    AND (storage.foldername(name))[1] = (public.current_org_id())::text
    AND public.has_permission('crm','documents','create')
  );

CREATE POLICY "Guest documents: removed by authorised staff"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'guest-documents'
    AND (storage.foldername(name))[1] = (public.current_org_id())::text
    AND public.has_permission('crm','documents','delete')
  );

-- Capabilities for guest documents (no role assignments invented here)
INSERT INTO public.permissions (module, feature, action, label)
SELECT 'crm','documents', a, 'Guest documents — ' || a
FROM unnest(ARRAY['view','create','edit','delete']) a
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions p
   WHERE p.module='crm' AND p.feature='documents' AND p.action=a
);

-- ============ Inventory: real Item Group level ============
CREATE TABLE IF NOT EXISTS public.stock_item_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  code text,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_item_groups TO authenticated;
GRANT ALL ON public.stock_item_groups TO service_role;
ALTER TABLE public.stock_item_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "item groups readable in the workspace"
  ON public.stock_item_groups FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

CREATE POLICY "item groups managed by stock editors"
  ON public.stock_item_groups FOR ALL TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.has_permission('stores','catalogue','edit')
              OR public.has_permission('stores','items','edit')))
  WITH CHECK (organization_id = public.current_org_id()
              AND (public.has_permission('stores','catalogue','edit')
                   OR public.has_permission('stores','items','edit')));

CREATE TRIGGER stock_item_groups_touch
  BEFORE UPDATE ON public.stock_item_groups
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- Categories keep every existing row; the group link stays empty until mapped by the owner.
ALTER TABLE public.stock_categories
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.stock_item_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS stock_categories_group_idx ON public.stock_categories (group_id);