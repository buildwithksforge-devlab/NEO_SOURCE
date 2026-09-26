CREATE TABLE IF NOT EXISTS public.perm_diagnostics (
  id bigserial primary key,
  run_at timestamptz not null default now(),
  user_id uuid,
  user_name text,
  role_names text,
  module text,
  check_kind text,
  result boolean,
  detail text
);
GRANT SELECT ON public.perm_diagnostics TO authenticated;
GRANT ALL ON public.perm_diagnostics TO service_role;
ALTER TABLE public.perm_diagnostics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "perm diagnostics admin read" ON public.perm_diagnostics FOR SELECT TO authenticated USING (public.is_org_admin());

DO $$
DECLARE u record; m text; ok boolean; eff int;
BEGIN
  DELETE FROM public.perm_diagnostics;
  FOR u IN
    SELECT p.id, p.full_name,
           (SELECT string_agg(r.name, ', ') FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id WHERE ur.user_id = p.id) AS roles
    FROM public.profiles p
    WHERE p.account_type = 'staff'
  LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u.id, 'role', 'authenticated')::text, true);
    SELECT count(*) INTO eff FROM public.my_effective_permissions();
    INSERT INTO public.perm_diagnostics(user_id, user_name, role_names, module, check_kind, result, detail)
    VALUES (u.id, u.full_name, u.roles, '-', 'effective_count', eff > 0, eff::text);
    FOREACH m IN ARRAY ARRAY['front-office','restaurant','bar','kitchen','housekeeping','laundry','maintenance','stores','procurement','finance','marketing','events','delivery','human-resources','administration','analytics','reports','ai','integrations','platform'] LOOP
      SELECT public.has_permission(m, 'view') INTO ok;
      INSERT INTO public.perm_diagnostics(user_id, user_name, role_names, module, check_kind, result)
      VALUES (u.id, u.full_name, u.roles, m, 'module_view', ok);
    END LOOP;
  END LOOP;
  PERFORM set_config('request.jwt.claims', NULL, true);
END $$;