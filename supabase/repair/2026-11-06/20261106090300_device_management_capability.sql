-- Approved dedicated device capability. Catalogue definitions only.
-- Existing user-management permissions and live role assignments are unchanged.
-- After isolated UAT review, compile these templates only for the explicitly selected organisation.
BEGIN;
INSERT INTO public.permissions(module,feature,action,label)
VALUES ('administration','devices','manage','Manage property devices and staff PINs')
ON CONFLICT (module,feature,action) DO NOTHING;

INSERT INTO public.role_feature_templates(role_key,module,feature,action)
VALUES
  ('owner','administration','devices','manage'),
  ('it-system-administrator','administration','devices','manage')
ON CONFLICT (role_key,module,feature,action) DO NOTHING;
COMMIT;