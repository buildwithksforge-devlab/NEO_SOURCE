WITH feat(feature, label) AS (VALUES
  ('overview','Marketing dashboard'),('pipeline','Lead pipeline'),('campaigns','Campaigns'),
  ('calendar','Marketing calendar'),('content','Content & approvals'),('automations','Marketing automations'),
  ('templates','Message templates'),('promotions','Promotions & vouchers'),('referrals','Referrals'),
  ('reviews','Reviews & reputation'),('recovery','Service recovery'),('consent','Audience consent'),
  ('suppression','Suppression lists'),('reports','Campaign reports'),('tasks','Marketing tasks'),
  ('stock_needs','Marketing supplies'),('settings','Marketing settings')
), act(action) AS (VALUES ('view'),('create'),('edit'),('export'))
INSERT INTO public.permissions (module, feature, action, label)
SELECT 'marketing', f.feature, a.action, f.label || ' — ' || a.action
FROM feat f CROSS JOIN act a
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions p
   WHERE p.module='marketing' AND p.feature=f.feature AND p.action=a.action
);

WITH feat(feature) AS (VALUES
  ('overview'),('pipeline'),('campaigns'),('calendar'),('content'),('automations'),('templates'),
  ('promotions'),('referrals'),('reviews'),('recovery'),('consent'),('suppression'),('reports'),
  ('tasks'),('stock_needs'),('settings')
), act(action) AS (VALUES ('view'),('create'),('edit'),('export'))
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'marketing-manager', 'marketing', f.feature, a.action
FROM feat f CROSS JOIN act a
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_feature_templates t
   WHERE t.role_key='marketing-manager' AND t.module='marketing'
     AND t.feature=f.feature AND t.action=a.action
);