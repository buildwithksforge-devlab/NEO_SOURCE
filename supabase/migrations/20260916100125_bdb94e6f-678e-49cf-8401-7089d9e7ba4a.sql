
-- One shared resolver: the ONLY place a recommended template row is turned
-- into a live permission. Diff and apply both read it, so the missing list and
-- the apply action can never disagree again.
CREATE OR REPLACE FUNCTION public.recommended_template_grants(_role_id uuid)
RETURNS TABLE(template_module text, template_action text, permission_id uuid, module text, action text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH r AS (
    SELECT id, name FROM public.roles WHERE id = _role_id
  ),
  tpl AS (
    SELECT DISTINCT t.module, t.action
    FROM public.role_permission_templates t, r
    WHERE t.version = 1 AND t.template_key = lower(btrim(r.name))
  )
  SELECT tpl.module, tpl.action, m.permission_id, m.module, m.action
  FROM tpl
  LEFT JOIN LATERAL (
    SELECT DISTINCT p.id AS permission_id, p.module, p.action
    FROM public.canonical_permission(tpl.module, '*', tpl.action) c
    JOIN public.permissions p
      ON p.module = c.module AND p.feature = c.feature AND p.action = c.action
    WHERE (
        position('.' in tpl.action) > 0
        OR p.feature NOT IN ('menu','settings','configuration','pricing','rate_plans','catalogue')
        OR p.action IN ('view','print','export','access')
      )
      AND (
        position('.' in tpl.action) > 0
        OR p.module <> 'finance'
        OR p.feature NOT IN ('gl','journals','ledger','period','banking','reconciliation')
      )
  ) m ON true;
$fn$;

REVOKE ALL ON FUNCTION public.recommended_template_grants(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.recommended_template_grants(uuid) TO authenticated, service_role;

-- Diff now reports four honest states: add / retained / custom / unavailable.
CREATE OR REPLACE FUNCTION public.recommended_role_diff(_role_id uuid)
RETURNS TABLE(module text, action text, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH r AS (
    SELECT * FROM public.roles
    WHERE id = _role_id
      AND organization_id = public.current_org_id()
      AND public.is_org_admin()
  ),
  g AS (
    SELECT * FROM public.recommended_template_grants(_role_id), r
  ),
  wanted AS (
    SELECT DISTINCT g.permission_id, g.module, g.action FROM g WHERE g.permission_id IS NOT NULL
  ),
  unavailable AS (
    SELECT DISTINCT g.template_module AS module, g.template_action AS action
    FROM g WHERE g.permission_id IS NULL
  ),
  cur AS (
    SELECT DISTINCT p.id AS permission_id, p.module, p.action
    FROM public.role_permissions rp
    JOIN public.permissions p ON p.id = rp.permission_id, r
    WHERE rp.role_id = r.id
  )
  SELECT coalesce(w.module, c.module) AS module,
         coalesce(w.action, c.action) AS action,
         CASE WHEN c.permission_id IS NULL THEN 'add'
              WHEN w.permission_id IS NULL THEN 'custom'
              ELSE 'retained' END AS status
  FROM wanted w
  FULL OUTER JOIN cur c ON c.permission_id = w.permission_id
  UNION ALL
  SELECT u.module, u.action, 'unavailable' FROM unavailable u;
$fn$;

-- Apply: idempotent upsert of every resolvable grant, then verification.
-- Returns the truth, including how many remain missing afterwards.
CREATE OR REPLACE FUNCTION public.apply_recommended_permissions(_role_id uuid, _reset boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
declare
  _org uuid;
  _name text;
  _added int := 0;
  _removed int := 0;
  _wanted_count int := 0;
  _missing_after int := 0;
  _unavailable jsonb := '[]'::jsonb;
begin
  select organization_id, name into _org, _name from public.roles where id = _role_id;
  if _org is null then raise exception 'Role not found'; end if;
  if _org is distinct from public.current_org_id() or not public.can_manage_workforce() then
    raise exception 'Not authorized';
  end if;

  -- Serialise concurrent reconciliation of the same role.
  perform pg_advisory_xact_lock(hashtextextended(_role_id::text, 0));

  create temp table _wanted on commit drop as
  select distinct permission_id
  from public.recommended_template_grants(_role_id)
  where permission_id is not null;

  select count(*) into _wanted_count from _wanted;

  select coalesce(jsonb_agg(distinct jsonb_build_object('module', template_module, 'action', template_action)), '[]'::jsonb)
    into _unavailable
  from public.recommended_template_grants(_role_id)
  where permission_id is null;

  insert into public.role_permissions (organization_id, role_id, permission_id)
  select _org, _role_id, w.permission_id from _wanted w
  on conflict (role_id, permission_id) do nothing;
  get diagnostics _added = row_count;

  if _reset then
    delete from public.role_permissions rp
    where rp.role_id = _role_id
      and not exists (select 1 from _wanted w where w.permission_id = rp.permission_id);
    get diagnostics _removed = row_count;
  end if;

  -- Verify persisted rows rather than trusting the write.
  select count(*) into _missing_after
  from _wanted w
  where not exists (
    select 1 from public.role_permissions rp
    where rp.role_id = _role_id and rp.permission_id = w.permission_id
  );

  drop table if exists _wanted;

  insert into public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  values (_org, auth.uid(), coalesce((select full_name from public.profiles where id = auth.uid()), ''),
          case when _reset then 'role.permissions.reset_to_recommended' else 'role.permissions.apply_recommended' end,
          'administration', _role_id,
          jsonb_build_object('role', _name, 'template_version', 1, 'added', _added,
                             'removed', _removed, 'expected', _wanted_count,
                             'missing_after', _missing_after, 'unavailable', _unavailable));

  if _missing_after > 0 then
    raise exception 'Reconciliation incomplete: % of % recommended permissions could not be persisted for role %',
      _missing_after, _wanted_count, _name;
  end if;

  return jsonb_build_object(
    'ok', true,
    'role', _name,
    'added', _added,
    'removed', _removed,
    'expected', _wanted_count,
    'missing_after', 0,
    'unavailable', _unavailable
  );
end;
$fn$;

REVOKE ALL ON FUNCTION public.apply_recommended_permissions(uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.apply_recommended_permissions(uuid, boolean) TO authenticated, service_role;
