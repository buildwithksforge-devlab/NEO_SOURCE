DROP POLICY IF EXISTS "customer_inserts_own_consent" ON public.customer_consents;
CREATE POLICY "customer_inserts_own_consent"
ON public.customer_consents
FOR INSERT
TO authenticated
WITH CHECK (
  is_my_customer(customer_id)
  AND consent_source = 'guest-portal'
);

DROP POLICY IF EXISTS "knowledge_articles_platform_read" ON public.knowledge_articles;
CREATE POLICY "knowledge_articles_platform_read"
ON public.knowledge_articles
FOR SELECT
TO authenticated
USING (
  organization_id IS NULL
  AND status = 'published'
  AND coalesce(audience, 'all_staff') IN ('all_staff', 'public', 'guest')
);