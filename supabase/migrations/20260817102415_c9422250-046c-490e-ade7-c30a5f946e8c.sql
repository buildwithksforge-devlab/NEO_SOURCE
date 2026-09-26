create table if not exists public.role_permission_templates (
  id uuid primary key default gen_random_uuid(),
  version integer not null default 1,
  template_name text not null,
  template_key text not null,
  module text not null,
  action text not null,
  created_at timestamptz not null default now(),
  unique (version, template_key, module, action)
);

grant select on public.role_permission_templates to authenticated;
grant all on public.role_permission_templates to service_role;
alter table public.role_permission_templates enable row level security;

drop policy if exists "Authenticated may read role templates" on public.role_permission_templates;
create policy "Authenticated may read role templates"
  on public.role_permission_templates for select to authenticated using (true);

delete from public.role_permission_templates where version = 1;

insert into public.role_permission_templates (template_name, template_key, module, action)
select g.role_name, lower(btrim(g.role_name)), m, a
from (values
('Owner',array['front-office','restaurant','bar','kitchen','housekeeping','laundry','procurement','stores','finance','marketing','events','maintenance','delivery','human-resources','administration','reports','analytics','ai','integrations','migration','quality','support','platform'],array['approve','create','delete','edit','export','override','print','refund','reject','view','void']),
('System Administrator',array['administration','platform','integrations','migration','quality','support'],array['approve','create','delete','edit','export','override','print','reject','view']),
('System Administrator',array['reports','analytics','ai','front-office','restaurant','bar','kitchen','housekeeping','laundry','procurement','stores','marketing','events','maintenance','delivery','finance','human-resources'],array['export','print','view']),
('General Manager',array['front-office','restaurant','bar'],array['approve','create','edit','export','override','print','refund','reject','view','void']),
('General Manager',array['kitchen','housekeeping','laundry','procurement','stores','marketing','events','maintenance','delivery'],array['approve','create','edit','export','override','print','reject','view']),
('General Manager',array['finance'],array['approve','export','print','reject','view']),
('General Manager',array['human-resources','reports','analytics'],array['export','print','view']),
('General Manager',array['ai','administration'],array['view']),
('Operations Manager',array['front-office','restaurant','bar','kitchen','housekeeping','laundry','stores','events','maintenance','delivery'],array['approve','create','edit','export','override','print','reject','view']),
('Operations Manager',array['reports','analytics'],array['export','print','view']),
('Finance Manager',array['finance'],array['approve','create','edit','export','override','print','refund','reject','view','void']),
('Finance Manager',array['reports','analytics','front-office','restaurant','bar','procurement','stores','events','delivery','marketing'],array['export','print','view']),
('Finance Manager',array['administration'],array['view']),
('Accountant',array['finance'],array['create','edit','export','print','view']),
('Accountant',array['reports','analytics','front-office','restaurant','bar','procurement','stores','events','delivery'],array['export','print','view']),
('Front Office Manager',array['front-office'],array['approve','create','edit','export','override','print','reject','view']),
('Front Office Manager',array['housekeeping','laundry','maintenance','restaurant','analytics'],array['view']),
('Front Office Manager',array['finance','reports'],array['export','print','view']),
('Receptionist',array['front-office'],array['create','edit','print','view']),
('Receptionist',array['housekeeping','restaurant'],array['view']),
('Receptionist',array['laundry','maintenance'],array['create','view']),
('Restaurant Manager',array['restaurant'],array['approve','create','edit','export','override','print','reject','view','void']),
('Restaurant Manager',array['kitchen','stores','bar','analytics'],array['view']),
('Restaurant Manager',array['reports'],array['export','print','view']),
('Waiter',array['restaurant'],array['create','edit','print','view']),
('Waiter',array['kitchen','front-office'],array['view']),
('Bar Manager',array['bar'],array['approve','create','edit','export','override','print','reject','view','void']),
('Bar Manager',array['stores','restaurant'],array['view']),
('Bar Manager',array['reports'],array['export','print','view']),
('Bar Attendant',array['bar'],array['create','edit','print','view']),
('Bar Attendant',array['restaurant'],array['view']),
('Coffee Station Supervisor',array['restaurant'],array['approve','create','edit','export','print','reject','view']),
('Coffee Station Supervisor',array['kitchen','stores'],array['view']),
('Barista',array['restaurant'],array['create','edit','print','view']),
('Kitchen Manager',array['kitchen'],array['approve','create','edit','export','override','print','reject','view']),
('Kitchen Manager',array['stores'],array['create','view']),
('Kitchen Manager',array['restaurant','analytics'],array['view']),
('Kitchen Manager',array['reports'],array['export','print','view']),
('Chef',array['kitchen'],array['create','edit','print','view']),
('Chef',array['stores','restaurant'],array['view']),
('Hot Kitchen Supervisor',array['kitchen'],array['approve','create','edit','export','print','reject','view']),
('Hot Kitchen Supervisor',array['stores'],array['create','view']),
('Hot Kitchen Supervisor',array['restaurant'],array['view']),
('Pastry Supervisor',array['kitchen'],array['approve','create','edit','export','print','reject','view']),
('Pastry Supervisor',array['stores'],array['create','view']),
('Pastry Supervisor',array['restaurant'],array['view']),
('Pastry Chef',array['kitchen'],array['create','edit','print','view']),
('Procurement Officer',array['procurement'],array['create','delete','edit','export','print','view']),
('Procurement Officer',array['stores','finance'],array['view']),
('Storekeeper',array['stores'],array['create','delete','edit','export','print','view']),
('Storekeeper',array['procurement','kitchen'],array['view']),
('Housekeeping Supervisor',array['housekeeping'],array['approve','create','edit','export','print','reject','view']),
('Housekeeping Supervisor',array['laundry','maintenance','stores'],array['create','view']),
('Housekeeping Supervisor',array['front-office'],array['view']),
('Housekeeper',array['housekeeping'],array['create','edit','view']),
('Housekeeper',array['maintenance'],array['create','view']),
('Housekeeper',array['laundry'],array['view']),
('Laundry Supervisor',array['laundry'],array['approve','create','edit','export','print','reject','view']),
('Laundry Supervisor',array['housekeeping'],array['view']),
('Laundry Attendant',array['laundry'],array['create','edit','view']),
('Maintenance Officer',array['maintenance'],array['create','edit','print','view']),
('Maintenance Officer',array['housekeeping'],array['view']),
('Maintenance Officer',array['stores'],array['create','view']),
('Maintenance Manager',array['maintenance'],array['approve','create','edit','export','override','print','reject','view']),
('Maintenance Manager',array['stores'],array['create','view']),
('Maintenance Manager',array['housekeeping'],array['view']),
('Events Manager',array['events'],array['approve','create','edit','export','print','reject','view']),
('Events Manager',array['front-office','restaurant','kitchen','finance','marketing'],array['view']),
('Events Manager',array['reports'],array['export','print','view']),
('Marketing Manager',array['marketing'],array['approve','create','edit','export','print','reject','view']),
('Marketing Manager',array['analytics'],array['export','view']),
('Marketing Manager',array['reports'],array['export','print','view']),
('Marketing Manager',array['events'],array['view']),
('Human Resources',array['human-resources'],array['approve','create','edit','export','print','reject','view']),
('Human Resources',array['reports'],array['export','print','view']),
('Human Resources',array['analytics'],array['view']),
('Delivery Manager',array['delivery'],array['approve','create','edit','export','override','print','reject','view']),
('Delivery Manager',array['restaurant','finance'],array['view']),
('Delivery Manager',array['reports'],array['export','print','view']),
('Rider',array['delivery'],array['create','edit','view'])
) as g(role_name, modules, actions)
cross join lateral unnest(g.modules) as m
cross join lateral unnest(g.actions) as a
on conflict do nothing;

create or replace function public.recommended_role_diff(_role_id uuid)
returns table (module text, action text, status text)
language sql
stable
security definer
set search_path = public
as $$
  with r as (
    select * from public.roles
    where id = _role_id
      and organization_id = public.current_org_id()
      and public.is_org_admin()
  ),
  tpl as (
    select t.module, t.action
    from public.role_permission_templates t, r
    where t.version = 1 and t.template_key = lower(btrim(r.name))
  ),
  cur as (
    select p.module, p.action
    from public.role_permissions rp
    join public.permissions p on p.id = rp.permission_id, r
    where rp.role_id = r.id
  )
  select coalesce(t.module, c.module) as module,
         coalesce(t.action, c.action) as action,
         case when c.module is null then 'add'
              when t.module is null then 'custom'
              else 'retained' end as status
  from tpl t
  full outer join cur c on c.module = t.module and c.action = t.action;
$$;

revoke all on function public.recommended_role_diff(uuid) from public, anon;
grant execute on function public.recommended_role_diff(uuid) to authenticated;

create or replace function public.apply_recommended_permissions(_role_id uuid, _reset boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _org uuid;
  _name text;
  _added int := 0;
  _removed int := 0;
begin
  select organization_id, name into _org, _name from public.roles where id = _role_id;
  if _org is null then raise exception 'Role not found'; end if;
  if _org is distinct from public.current_org_id() or not public.is_org_admin() then
    raise exception 'Not authorized';
  end if;

  insert into public.role_permissions (organization_id, role_id, permission_id)
  select _org, _role_id, p.id
  from public.role_permission_templates t
  join public.permissions p on p.module = t.module and p.action = t.action
  where t.version = 1 and t.template_key = lower(btrim(_name))
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
$$;

revoke all on function public.apply_recommended_permissions(uuid, boolean) from public, anon;
grant execute on function public.apply_recommended_permissions(uuid, boolean) to authenticated;