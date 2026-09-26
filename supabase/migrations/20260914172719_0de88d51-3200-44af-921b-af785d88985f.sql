INSERT INTO public.permissions (module, feature, action, label) VALUES
  ('administration','settings','edit','Edit configuration centre settings'),
  ('administration','settings','export','Export configuration settings'),
  ('administration','workspace','view','View workspace configuration'),
  ('administration','workspace','edit','Edit workspace configuration'),
  ('administration','branding','view','View brand identity settings'),
  ('administration','branding','edit','Edit brand identity settings'),
  ('administration','documents','view','View document settings'),
  ('administration','documents','edit','Edit document settings'),
  ('administration','communication','view','View communication settings'),
  ('administration','communication','edit','Edit communication settings'),
  ('administration','stations','create','Create stations'),
  ('administration','stations','edit','Edit stations'),
  ('administration','stations','export','Export stations')
ON CONFLICT DO NOTHING;