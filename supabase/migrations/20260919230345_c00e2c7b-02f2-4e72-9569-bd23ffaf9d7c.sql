INSERT INTO public.privileged_function_review
  (function_name, identity_arguments, reachability, sensitive, establishes_tenant_context,
   classification, trusts_client_tenant, search_path_fixed, domain, review_note)
VALUES
  ('neo_snapshot_verify', '_snapshot uuid', 'app_callable', false, false,
   'tenant_derived_privileged', false, true, 'other',
   'Verifies a stored snapshot against live records; derives the workspace from the snapshot row and the session, never from a caller-supplied workspace.'),
  ('neo_tenant_begin_offboarding', '_reason text', 'app_callable', false, false,
   'tenant_derived_privileged', false, true, 'other',
   'Moves the current workspace into off-boarding; requires a suspended workspace, a stated reason and a verified export.')
ON CONFLICT DO NOTHING;