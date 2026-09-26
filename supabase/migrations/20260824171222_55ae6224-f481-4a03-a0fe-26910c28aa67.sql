INSERT INTO public.permissions (module, feature, action, label)
SELECT 'front-office', v.feature, v.action,
       initcap(replace(v.feature, '_', ' ')) || ' — ' || v.action
FROM (
  SELECT f.feature, a.action
  FROM (VALUES ('tasks'), ('stock_needs'), ('requisitions'), ('intelligence')) AS f(feature)
  CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('approve'), ('export'), ('print')) AS a(action)
) v
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions p
  WHERE p.module = 'front-office' AND p.feature = v.feature AND p.action = v.action
);

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'receptionist', 'front-office', v.feature, v.action
FROM (VALUES
  ('tasks','view'), ('tasks','edit'),
  ('stock_needs','view'), ('stock_needs','create')
) AS v(feature, action)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_feature_templates t
  WHERE t.role_key = 'receptionist' AND t.module = 'front-office'
    AND t.feature = v.feature AND t.action = v.action
);

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT v.role_key, 'front-office', v.feature, v.action
FROM (
  SELECT r.role_key, f.feature, a.action
  FROM (VALUES ('front-office-manager'), ('front-office-supervisor')) AS r(role_key)
  CROSS JOIN (VALUES ('tasks'), ('stock_needs'), ('requisitions'), ('intelligence')) AS f(feature)
  CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('approve'), ('export'), ('print')) AS a(action)
) v
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_feature_templates t
  WHERE t.role_key = v.role_key AND t.module = 'front-office'
    AND t.feature = v.feature AND t.action = v.action
);

DO $$
DECLARE _o uuid;
BEGIN
  FOR _o IN SELECT id FROM public.organizations LOOP
    PERFORM public.neo_apply_feature_templates(_o);
  END LOOP;
END $$;
