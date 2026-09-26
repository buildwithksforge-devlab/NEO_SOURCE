
CREATE TABLE IF NOT EXISTS public.role_feature_template_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch text NOT NULL,
  role_key text NOT NULL,
  module text NOT NULL,
  feature text NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.role_feature_template_snapshots TO authenticated;
GRANT ALL ON public.role_feature_template_snapshots TO service_role;
ALTER TABLE public.role_feature_template_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='role_feature_template_snapshots' AND policyname='rfts_read') THEN
    EXECUTE $p$CREATE POLICY "rfts_read" ON public.role_feature_template_snapshots
      FOR SELECT TO authenticated USING (true)$p$;
  END IF;
END $$;

INSERT INTO public.role_feature_template_snapshots(batch, role_key, module, feature, action)
SELECT 'finance-scope-restore-2026-09-16', t.role_key, t.module, t.feature, t.action
FROM public.role_feature_templates t
WHERE (t.role_key = 'finance-manager'
       AND t.module IN ('restaurant','events','marketing','front-office','procurement')
       AND t.action NOT IN ('view','export'))
   OR (t.role_key = 'accountant'
       AND t.module = 'restaurant'
       AND t.action NOT IN ('view','export'));

DELETE FROM public.role_feature_templates t
USING public.role_feature_template_snapshots s
WHERE s.batch = 'finance-scope-restore-2026-09-16'
  AND t.role_key = s.role_key AND t.module = s.module
  AND t.feature = s.feature AND t.action = s.action;
