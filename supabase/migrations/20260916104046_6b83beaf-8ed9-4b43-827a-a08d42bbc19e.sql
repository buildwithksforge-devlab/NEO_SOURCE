-- Forensic restoration of role template lines removed by the 2026-09-16 template work.
-- 1) 20260916103149 deleted every template line with no *direct* permission match,
--    ignoring public.canonical_permission() alias resolution, which
--    recommended_template_grants() does use. Alias-written lines were therefore
--    legitimate and are restored here.
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT v.role_key, 'pms', 'checkin', 'revert'
FROM (VALUES ('front-office-manager'), ('operations-manager')) AS v(role_key)
JOIN public.role_catalogue c ON c.role_key = v.role_key AND NOT c.retired
WHERE EXISTS (
  SELECT 1 FROM public.canonical_permission('pms','checkin','revert') cp
  JOIN public.permissions p
    ON p.module = cp.module AND p.feature = cp.feature AND p.action = cp.action
)
ON CONFLICT (role_key, module, feature, action) DO NOTHING;

-- 2) 20260916102339 replaced the whole Cashier finance template and dropped two
--    pre-existing read-only lines that are not restricted actions.
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'cashier', 'finance', v.feature, 'view'
FROM (VALUES ('overview'), ('receivables')) AS v(feature)
WHERE EXISTS (
  SELECT 1 FROM public.permissions p
  WHERE p.module='finance' AND p.feature=v.feature AND p.action='view'
)
ON CONFLICT (role_key, module, feature, action) DO NOTHING;

-- 3) Report, never delete: template lines that cannot resolve to a live
--    permission are a catalogue gap to review, not rows to destroy.
CREATE OR REPLACE VIEW public.role_template_unresolvable_lines
WITH (security_invoker = true) AS
SELECT c.department,
       t.role_key,
       t.module,
       t.feature,
       t.action
FROM public.role_feature_templates t
JOIN public.role_catalogue c ON c.role_key = t.role_key AND NOT c.retired
WHERE NOT EXISTS (
  SELECT 1
  FROM public.canonical_permission(t.module, t.feature, t.action) cp
  JOIN public.permissions p
    ON p.module = cp.module AND p.feature = cp.feature AND p.action = cp.action
);

GRANT SELECT ON public.role_template_unresolvable_lines TO authenticated;
GRANT ALL ON public.role_template_unresolvable_lines TO service_role;