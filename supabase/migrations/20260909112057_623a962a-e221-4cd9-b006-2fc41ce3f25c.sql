-- 1. Explicit book-level template rows for the roles that keep the ledger.
INSERT INTO public.role_permission_templates (version, template_key, template_name, module, action)
SELECT 1, k.key, k.key, 'finance', f.feature || '.' || a.action
FROM (VALUES ('owner'),('owner / director'),('it-system-administrator'),
             ('finance manager'),('finance-manager'),('accountant')) AS k(key)
CROSS JOIN (VALUES ('gl'),('journals'),('ledger'),('period'),('banking'),('reconciliation')) AS f(feature)
CROSS JOIN (VALUES ('view')) AS a(action)
WHERE EXISTS (SELECT 1 FROM public.role_permission_templates t
               WHERE t.version = 1 AND t.template_key = k.key AND t.module = 'finance')
  AND NOT EXISTS (SELECT 1 FROM public.role_permission_templates t2
               WHERE t2.version = 1 AND t2.template_key = k.key AND t2.module = 'finance'
                 AND t2.action = f.feature || '.' || a.action);

INSERT INTO public.role_permission_templates (version, template_key, template_name, module, action)
SELECT 1, 'general manager', 'general manager', 'finance', f.feature || '.view'
FROM (VALUES ('gl'),('journals'),('ledger'),('reconciliation')) AS f(feature)
WHERE NOT EXISTS (SELECT 1 FROM public.role_permission_templates t
               WHERE t.version = 1 AND t.template_key = 'general manager'
                 AND t.module = 'finance' AND t.action = f.feature || '.view');

-- 2. A module-wide finance grant no longer reaches the books.
CREATE OR REPLACE FUNCTION public.apply_recommended_permissions(_role_id uuid, _reset boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
declare
  _org uuid;
  _name text;
  _added int := 0;
  _removed int := 0;
begin
  select organization_id, name into _org, _name from public.roles where id = _role_id;
  if _org is null then raise exception 'Role not found'; end if;
  if _org is distinct from public.current_org_id() or not public.can_manage_workforce() then
    raise exception 'Not authorized';
  end if;

  insert into public.role_permissions (organization_id, role_id, permission_id)
  select _org, _role_id, p.id
  from public.role_permission_templates t
  join public.permissions p on p.module = t.module and p.action = t.action
  where t.version = 1 and t.template_key = lower(btrim(_name))
    and (
      position('.' in t.action) > 0
      or p.feature not in ('menu','settings','configuration','pricing','rate_plans','catalogue')
      or p.action in ('view','print','export','access')
    )
    -- The accounting books are never conferred by a module-wide finance grant;
    -- they are only granted where the template names the feature itself.
    and (
      position('.' in t.action) > 0
      or p.module <> 'finance'
      or p.feature not in ('gl','journals','ledger','period','banking','reconciliation')
    )
    and not exists (
      select 1 from public.role_permissions rp
      where rp.role_id = _role_id and rp.permission_id = p.id
    );
  get diagnostics _added = row_count;

  if _reset then
    delete from public.role_permissions rp
    using public.permissions p
    where rp.role_id = _role_id and p.id = rp.permission_id
      and not exists (
        select 1 from public.role_permission_templates t
        where t.version = 1 and t.template_key = lower(btrim(_name))
          and t.module = p.module and t.action = p.action
          and (
            position('.' in t.action) > 0
            or p.feature not in ('menu','settings','configuration','pricing','rate_plans','catalogue')
            or p.action in ('view','print','export','access')
          )
          and (
            position('.' in t.action) > 0
            or p.module <> 'finance'
            or p.feature not in ('gl','journals','ledger','period','banking','reconciliation')
          )
      );
    get diagnostics _removed = row_count;
  end if;

  insert into public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  values (_org, auth.uid(), coalesce((select full_name from public.profiles where id = auth.uid()), ''),
          case when _reset then 'role.permissions.reset_to_recommended' else 'role.permissions.apply_recommended' end,
          'administration', _role_id,
          jsonb_build_object('role', _name, 'template_version', 1, 'added', _added, 'removed', _removed));

  return jsonb_build_object('role', _name, 'added', _added, 'removed', _removed);
end;
$function$;