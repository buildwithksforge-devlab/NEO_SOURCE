-- pms/pos are whole-module aliases (front-office / restaurant), not sub-features.
update public.permission_module_aliases set alias_feature = null
 where alias_module in ('pms','pos');

insert into public.permissions (module, feature, action, label)
select distinct c.module, c.feature, c.action,
       initcap(replace(c.action,'_',' ')) || ' ' || replace(c.feature,'-',' ') || ' (' || c.module || ')'
from public.role_permission_templates t
cross join lateral public.canonical_permission(t.module, '*', t.action) c
where t.version = 1
  and not exists (select 1 from public.permissions p
                  where p.module = c.module and p.feature = c.feature and p.action = c.action);

do $$
declare o record;
begin
  perform set_config('neo.internal','on', true);
  for o in select id from public.organizations loop
    perform public.neo_apply_role_templates(o.id, true);
  end loop;
end $$;