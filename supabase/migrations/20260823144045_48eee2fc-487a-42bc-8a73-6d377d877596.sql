INSERT INTO public.permissions (module, feature, action, label) VALUES
  ('marketing','feedback','view','View — marketing · feedback'),
  ('marketing','feedback','edit','Edit — marketing · feedback'),
  ('restaurant','room_charge','post','Post — restaurant · room charge')
ON CONFLICT (module, feature, action) DO NOTHING;

INSERT INTO public.permission_key_aliases (alias_module, alias_action, canonical_module, canonical_feature, canonical_action) VALUES
  ('crm-feedback','view','marketing','feedback','view'),
  ('crm-feedback','edit','marketing','feedback','edit'),
  ('pos','room_charge.post','restaurant','room_charge','post')
ON CONFLICT DO NOTHING;

DO $$
DECLARE _o uuid;
BEGIN
  PERFORM set_config('neo.internal','on',true);
  FOR _o IN SELECT id FROM public.organizations LOOP
    PERFORM public.neo_apply_role_templates(_o, true);
  END LOOP;
END $$;