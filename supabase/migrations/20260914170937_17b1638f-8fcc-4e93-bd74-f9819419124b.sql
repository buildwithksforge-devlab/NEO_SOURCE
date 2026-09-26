INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT rk, 'marketing', 'customers', 'merge'
FROM (VALUES ('owner'),('it-system-administrator'),('marketing-manager')) AS v(rk)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_feature_templates t
   WHERE t.role_key = v.rk AND t.module='marketing' AND t.feature='customers' AND t.action='merge'
);