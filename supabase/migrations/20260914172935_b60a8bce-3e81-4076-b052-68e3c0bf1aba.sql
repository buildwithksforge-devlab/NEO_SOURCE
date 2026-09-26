INSERT INTO public.permissions (module, feature, action, label) VALUES
  ('platform','readiness','view','View go-live readiness'),
  ('platform','readiness','edit','Update go-live readiness'),
  ('platform','readiness','approve','Approve go-live'),
  ('platform','environments','view','View environments and feature flags'),
  ('platform','environments','edit','Edit environments and feature flags'),
  ('platform','subscription','view','View subscription'),
  ('platform','subscription','edit','Manage subscription'),
  ('platform','operations','view','View releases and monitoring'),
  ('platform','operations','edit','Manage releases and monitoring'),
  ('integrations','centre','view','View integration centre'),
  ('integrations','centre','edit','Configure integrations'),
  ('quality','simulation','view','View simulation centre'),
  ('quality','simulation','edit','Run simulations'),
  ('quality','overview','approve','Approve defect resolutions'),
  ('migration','overview','approve','Approve data migrations'),
  ('support','overview','edit','Manage support and knowledge content')
ON CONFLICT DO NOTHING;