INSERT INTO public.permissions (module, feature, action, label) VALUES
  ('reports','staff-board','view','View the staff board'),
  ('reports','staff-board','export','Export the staff board'),
  ('ai','insights','view','View NEØ Intelligence')
ON CONFLICT DO NOTHING;