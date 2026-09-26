-- 1. Permission catalogue rows the Commercial routes already reference.
INSERT INTO public.permissions (module, feature, action, label) VALUES
  ('marketing','crm-overview','view','View CRM dashboard'),
  ('marketing','crm-overview','export','Export CRM dashboard'),
  ('marketing','crm-settings','view','View CRM settings'),
  ('marketing','crm-settings','edit','Edit CRM settings'),
  ('front-office','credit-accounts','view','View credit & corporate accounts'),
  ('front-office','credit-accounts','create','Create credit accounts'),
  ('front-office','credit-accounts','edit','Edit credit account terms'),
  ('front-office','credit-accounts','approve','Approve credit limits'),
  ('front-office','credit-accounts','export','Export credit account data')
ON CONFLICT DO NOTHING;

-- 2. Role templates, matching what each role already does elsewhere.
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT rk, m, f, a FROM (VALUES
  ('owner','marketing','crm-overview','view'),
  ('owner','marketing','crm-overview','export'),
  ('owner','marketing','crm-settings','view'),
  ('owner','marketing','crm-settings','edit'),
  ('owner','front-office','credit-accounts','view'),
  ('owner','front-office','credit-accounts','create'),
  ('owner','front-office','credit-accounts','edit'),
  ('owner','front-office','credit-accounts','approve'),
  ('owner','front-office','credit-accounts','export'),
  ('it-system-administrator','marketing','crm-overview','view'),
  ('it-system-administrator','marketing','crm-overview','export'),
  ('it-system-administrator','marketing','crm-settings','view'),
  ('it-system-administrator','marketing','crm-settings','edit'),
  ('it-system-administrator','front-office','credit-accounts','view'),
  ('it-system-administrator','front-office','credit-accounts','create'),
  ('it-system-administrator','front-office','credit-accounts','edit'),
  ('it-system-administrator','front-office','credit-accounts','approve'),
  ('it-system-administrator','front-office','credit-accounts','export'),
  ('operations-manager','marketing','crm-overview','view'),
  ('operations-manager','front-office','credit-accounts','view'),
  ('marketing-manager','marketing','crm-overview','view'),
  ('marketing-manager','marketing','crm-overview','export'),
  ('marketing-manager','marketing','crm-settings','view'),
  ('marketing-manager','marketing','crm-settings','edit'),
  ('finance-manager','marketing','crm-overview','view'),
  ('finance-manager','front-office','credit-accounts','view'),
  ('finance-manager','front-office','credit-accounts','create'),
  ('finance-manager','front-office','credit-accounts','edit'),
  ('finance-manager','front-office','credit-accounts','approve'),
  ('finance-manager','front-office','credit-accounts','export'),
  ('accountant','front-office','credit-accounts','view'),
  ('accountant','front-office','credit-accounts','export'),
  ('front-office-manager','front-office','credit-accounts','view'),
  ('front-office-manager','front-office','credit-accounts','create'),
  ('front-office-manager','front-office','credit-accounts','edit'),
  ('front-office-supervisor','front-office','credit-accounts','view'),
  ('reservations-agent','front-office','credit-accounts','view')
) AS v(rk, m, f, a)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_feature_templates t
   WHERE t.role_key = v.rk AND t.module = v.m AND t.feature = v.f AND t.action = v.a
);