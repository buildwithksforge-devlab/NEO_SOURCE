CREATE OR REPLACE FUNCTION public.neo_ctx_tag() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(auth.uid()::text,'anon')
      || ':' || coalesce(nullif(current_setting('neo.system_org', true),''),'-')
      || ':' || coalesce(nullif(current_setting('neo.ctx.gen', true),''),'0')
$$;

CREATE OR REPLACE FUNCTION public.neo_ctx_read(_key text) RETURNS text
LANGUAGE plpgsql STABLE AS $$
declare raw text; tag text;
begin
  raw := current_setting('neo.ctx.'||_key, true);
  if raw is null or raw = '' then return null; end if;
  tag := public.neo_ctx_tag();
  if left(raw, length(tag)+1) <> tag||'|' then return null; end if;
  return substr(raw, length(tag)+2);
end $$;

CREATE OR REPLACE FUNCTION public.neo_ctx_write(_key text, _payload text) RETURNS void
LANGUAGE plpgsql STABLE AS $$
begin
  perform set_config('neo.ctx.'||_key, public.neo_ctx_tag()||'|'||_payload, true);
exception when others then
  null;
end $$;

CREATE OR REPLACE FUNCTION public.neo_access_cache_bump() RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
begin
  perform set_config('neo.ctx.gen',
    (coalesce(nullif(current_setting('neo.ctx.gen', true),''),'0')::bigint + 1)::text, true);
exception when others then
  null;
end $$;

CREATE OR REPLACE FUNCTION public.neo_access_cache_bump_tg() RETURNS trigger
LANGUAGE plpgsql AS $$
begin
  perform public.neo_access_cache_bump();
  return null;
end $$;

GRANT EXECUTE ON FUNCTION public.neo_ctx_tag(), public.neo_ctx_read(text),
  public.neo_ctx_write(text,text), public.neo_access_cache_bump()
  TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION public.current_org_id() RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
declare c text; v uuid;
begin
  c := public.neo_ctx_read('org');
  if c is not null then return case when c = 'n' then null else substr(c,2)::uuid end; end if;
  SELECT COALESCE(
    (SELECT p.active_organization_id FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.account_type IN ('staff','platform_admin')
        AND p.account_status = 'active'
        AND p.active_organization_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.organization_memberships m
           WHERE m.user_id = p.id
             AND m.organization_id = p.active_organization_id
             AND m.status = 'active'
        )),
    (SELECT organization_id FROM public.profiles
      WHERE id = auth.uid()
        AND account_type IN ('staff','platform_admin')
        AND account_status = 'active'),
    CASE WHEN auth.uid() IS NULL
      THEN nullif(current_setting('neo.system_org', true), '')::uuid END
  ) into v;
  perform public.neo_ctx_write('org', case when v is null then 'n' else 'v'||v::text end);
  return v;
end $function$;

CREATE OR REPLACE FUNCTION public.is_active_staff() RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
declare c text; v boolean;
begin
  c := public.neo_ctx_read('active_staff');
  if c is not null then return c = 't'; end if;
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND coalesce(p.account_type, 'staff') = 'staff'
      AND coalesce(p.account_status, 'active') = 'active'
      AND p.organization_id = public.current_org_id()
  ) into v;
  perform public.neo_ctx_write('active_staff', case when v then 't' else 'f' end);
  return v;
end $function$;

CREATE OR REPLACE FUNCTION public.current_access_scope() RETURNS text
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
declare c text; v text;
begin
  c := public.neo_ctx_read('scope');
  if c is not null then return substr(c,2); end if;
  SELECT coalesce(
    (SELECT s.lvl FROM (
       SELECT coalesce(r.access_scope, public.role_scope_level(r.name)) AS lvl
       FROM public.user_roles ur
       JOIN public.roles r ON r.id = ur.role_id
       WHERE ur.user_id = auth.uid()
         AND ur.organization_id = public.current_org_id()
     ) s
     ORDER BY public.scope_rank(s.lvl) DESC
     LIMIT 1),
    'self') into v;
  perform public.neo_ctx_write('scope', 'v'||v);
  return v;
end $function$;

CREATE OR REPLACE FUNCTION public.current_branch_ids() RETURNS uuid[]
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
declare c text; v uuid[];
begin
  c := public.neo_ctx_read('branches');
  if c is not null then return substr(c,2)::uuid[]; end if;
  SELECT coalesce(array_agg(DISTINCT s.b), '{}'::uuid[])
    FROM (
      SELECT ub.branch_id AS b FROM public.user_branches ub
        WHERE ub.user_id = auth.uid() AND ub.branch_id IS NOT NULL
      UNION
      SELECT p.branch_id FROM public.profiles p
        WHERE p.id = auth.uid() AND p.branch_id IS NOT NULL
    ) s
    JOIN public.branches br ON br.id = s.b
   WHERE br.organization_id = public.current_org_id() into v;
  perform public.neo_ctx_write('branches', 'v'||v::text);
  return v;
end $function$;

CREATE OR REPLACE FUNCTION public.current_department_ids() RETURNS uuid[]
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
declare c text; v uuid[];
begin
  c := public.neo_ctx_read('departments');
  if c is not null then return substr(c,2)::uuid[]; end if;
  SELECT coalesce(array_agg(DISTINCT d), '{}'::uuid[]) FROM (
    SELECT ud.department_id AS d FROM public.user_departments ud
      WHERE ud.user_id = auth.uid() AND ud.department_id IS NOT NULL
    UNION
    SELECT p.department_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.department_id IS NOT NULL
  ) s into v;
  perform public.neo_ctx_write('departments', 'v'||v::text);
  return v;
end $function$;

CREATE OR REPLACE FUNCTION public.current_station_ids() RETURNS uuid[]
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
declare c text; v uuid[];
begin
  c := public.neo_ctx_read('stations');
  if c is not null then return substr(c,2)::uuid[]; end if;
  SELECT coalesce(array_agg(DISTINCT us.station_id), '{}'::uuid[])
  FROM public.user_stations us
  WHERE us.user_id = auth.uid() AND us.station_id IS NOT NULL into v;
  perform public.neo_ctx_write('stations', 'v'||v::text);
  return v;
end $function$;

CREATE OR REPLACE FUNCTION public.current_staff_id() RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
declare c text; v uuid;
begin
  c := public.neo_ctx_read('staff');
  if c is not null then return case when c='n' then null else substr(c,2)::uuid end; end if;
  SELECT id FROM public.profiles
  WHERE id = auth.uid()
    AND account_type IN ('staff','platform_admin')
    AND account_status = 'active' into v;
  perform public.neo_ctx_write('staff', case when v is null then 'n' else 'v'||v::text end);
  return v;
end $function$;

CREATE OR REPLACE FUNCTION public.current_user_role_ids() RETURNS uuid[]
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
declare c text; v uuid[];
begin
  c := public.neo_ctx_read('role_ids');
  if c is not null then return substr(c,2)::uuid[]; end if;
  SELECT CASE WHEN public.is_active_staff() THEN
    COALESCE((SELECT array_agg(ur.role_id) FROM public.user_roles ur
               WHERE ur.user_id = auth.uid()
                 AND ur.organization_id = public.current_org_id()), '{}'::uuid[])
  ELSE '{}'::uuid[] END into v;
  perform public.neo_ctx_write('role_ids', 'v'||v::text);
  return v;
end $function$;

CREATE OR REPLACE FUNCTION public.is_org_admin() RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
declare c text; v boolean;
begin
  c := public.neo_ctx_read('org_admin');
  if c is not null then return c = 't'; end if;
  SELECT public.is_active_staff() AND (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id,
      LATERAL public.role_permission_ids(r.id) rpi
      JOIN public.permissions p ON p.id = rpi.permission_id
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = public.current_org_id()
        AND r.organization_id = public.current_org_id()
        AND r.role_status <> 'archived' AND r.active
        AND p.module IN ('roles','permissions') AND p.action = 'manage'
    )
    OR EXISTS (
      SELECT 1 FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      WHERE up.user_id = auth.uid()
        AND up.organization_id = public.current_org_id()
        AND up.effect = 'grant'
        AND (up.valid_from IS NULL OR up.valid_from <= now())
        AND (up.valid_until IS NULL OR up.valid_until >= now())
        AND p.module IN ('roles','permissions') AND p.action = 'manage'
    )
  ) into v;
  perform public.neo_ctx_write('org_admin', case when v then 't' else 'f' end);
  return v;
end $function$;

CREATE OR REPLACE FUNCTION public.has_permission(_module text, _feature text, _action text) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
declare c text; v boolean;
begin
  c := public.neo_ctx_read('p.'||md5(_module||'|'||coalesce(_feature,'*')||'|'||_action));
  if c is not null then return c = 't'; end if;
  WITH want AS (
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS action_class
    FROM public.canonical_permission(_module, _feature, _action) c
  ), held AS (
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS action_class, 'deny'::text AS effect
    FROM public.user_permissions up JOIN public.permissions p ON p.id=up.permission_id,
         LATERAL public.canonical_permission(p.module,p.feature,p.action) c
    WHERE up.user_id=auth.uid() AND up.effect='deny' AND up.organization_id=public.current_org_id()
    UNION ALL
    SELECT c.module,c.feature,c.action,public.permission_action_class(c.action),'grant'
    FROM public.user_roles ur
    JOIN public.roles r ON r.id=ur.role_id AND r.active,
         LATERAL public.role_permission_ids(r.id) rpi
    JOIN public.permissions p ON p.id=rpi.permission_id,
         LATERAL public.canonical_permission(p.module,p.feature,p.action) c
    WHERE ur.user_id=auth.uid() AND ur.organization_id=public.current_org_id()
      AND r.organization_id=public.current_org_id()
    UNION ALL
    SELECT c.module,c.feature,c.action,public.permission_action_class(c.action),'grant'
    FROM public.user_permissions up JOIN public.permissions p ON p.id=up.permission_id,
         LATERAL public.canonical_permission(p.module,p.feature,p.action) c
    WHERE up.user_id=auth.uid() AND up.effect='grant' AND up.organization_id=public.current_org_id()
  )
  SELECT CASE
    WHEN NOT public.is_active_staff() THEN false
    WHEN public.is_org_admin() THEN true
    WHEN EXISTS (
      SELECT 1 FROM held h,want w WHERE h.effect='deny' AND h.module=w.module
        AND (w.feature='*' OR h.feature IN (w.feature,'*'))
        AND (h.action=w.action OR h.action_class=w.action_class)
    ) THEN false
    ELSE EXISTS (
      SELECT 1 FROM held h,want w WHERE h.effect='grant' AND h.module=w.module
        AND (w.feature='*' OR h.feature IN (w.feature,'*'))
        AND (h.action=w.action OR h.action_class=w.action_class)
    )
  END into v;
  perform public.neo_ctx_write('p.'||md5(_module||'|'||coalesce(_feature,'*')||'|'||_action), case when v then 't' else 'f' end);
  return v;
end $function$;

CREATE OR REPLACE FUNCTION public.has_explicit_permission(_module text, _feature text, _action text) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
declare c text; v boolean;
begin
  c := public.neo_ctx_read('x.'||md5(_module||'|'||coalesce(_feature,'*')||'|'||_action));
  if c is not null then return c = 't'; end if;
  WITH want AS (
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS action_class
      FROM public.canonical_permission(_module, _feature, _action) c
  ), held AS (
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS action_class, 'deny'::text AS effect
      FROM public.user_permissions up JOIN public.permissions p ON p.id = up.permission_id,
           LATERAL public.canonical_permission(p.module, p.feature, p.action) c
     WHERE up.user_id = auth.uid() AND up.effect = 'deny' AND up.organization_id = public.current_org_id()
    UNION ALL
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action), 'grant'
      FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id AND r.active,
           LATERAL public.role_permission_ids(r.id) rpi
      JOIN public.permissions p ON p.id = rpi.permission_id,
           LATERAL public.canonical_permission(p.module, p.feature, p.action) c
     WHERE ur.user_id = auth.uid() AND ur.organization_id = public.current_org_id()
       AND r.organization_id = public.current_org_id()
    UNION ALL
    SELECT c.module, c.feature, c.action, public.permission_action_class(c.action), 'grant'
      FROM public.user_permissions up JOIN public.permissions p ON p.id = up.permission_id,
           LATERAL public.canonical_permission(p.module, p.feature, p.action) c
     WHERE up.user_id = auth.uid() AND up.effect = 'grant' AND up.organization_id = public.current_org_id()
  )
  SELECT CASE
    WHEN NOT public.is_active_staff() THEN false
    WHEN public.is_org_admin() THEN true
    WHEN EXISTS (SELECT 1 FROM held h, want w
                  WHERE h.effect = 'deny' AND h.module = w.module AND h.feature = w.feature
                    AND (h.action = w.action OR h.action_class = w.action_class)) THEN false
    ELSE EXISTS (SELECT 1 FROM held h, want w
                  WHERE h.effect = 'grant' AND h.module = w.module AND h.feature = w.feature
                    AND (h.action = w.action OR h.action_class = w.action_class))
  END into v;
  perform public.neo_ctx_write('x.'||md5(_module||'|'||coalesce(_feature,'*')||'|'||_action), case when v then 't' else 'f' end);
  return v;
end $function$;

DO $$
declare t text;
begin
  foreach t in array array['user_roles','user_permissions','role_permissions_base','role_permission_overrides','roles','user_branches','user_departments','user_stations','organization_memberships','profiles']
  loop
    if to_regclass('public.'||t) is not null then
      execute format('drop trigger if exists trg_neo_access_cache_bump on public.%I', t);
      execute format('create trigger trg_neo_access_cache_bump after insert or update or delete on public.%I for each statement execute function public.neo_access_cache_bump_tg()', t);
    end if;
  end loop;
end $$;