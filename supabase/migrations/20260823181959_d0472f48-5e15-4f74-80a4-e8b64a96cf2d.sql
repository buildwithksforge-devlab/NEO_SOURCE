alter table public.permission_module_aliases
  add column if not exists alias_feature text;

update public.permission_module_aliases a set alias_feature = v.f
from (values
  ('ai-insights','insights'),('alerts','alerts'),
  ('audit_logs','audit-logs'),('departments','departments'),('permissions','permissions'),
  ('roles','roles'),('security','security'),('settings','settings'),('stations','stations'),
  ('users','users'),
  ('automation','automation'),('automation-ai','automation-ai'),('automation-providers','providers'),
  ('crm-ai','ai'),('crm-communications','communications'),('crm-corporate','corporate'),
  ('crm-credit','credit'),('crm-customers','customers'),('crm-feedback','feedback'),
  ('crm-identity','identity'),('crm-loyalty','loyalty'),('crm-preferences','preferences'),
  ('crm-segments','segments'),
  ('dashboards','dashboards'),('executive-dashboard','executive'),('kpis','kpis'),
  ('finance-ap','ap'),('finance-ar','ar'),('finance-gl','gl'),('finance-payments','payments'),
  ('finance-reports','reports'),('finance-tax','tax'),
  ('hr-announcements','announcements'),('hr-attendance','attendance'),('hr-employees','employees'),
  ('hr-leave','leave'),('hr-payroll','payroll'),('hr-performance','performance'),
  ('hr-recruitment','recruitment'),('hr-reports','reports'),('hr-scheduling','scheduling'),
  ('hr-training','training'),
  ('pms','pms'),('pos','pos')
) as v(m,f)
where a.alias_module = v.m;

create or replace function public.canonical_permission(_module text, _feature text, _action text)
returns table(module text, feature text, action text)
language sql
stable
security definer
set search_path = public
as $$
  WITH al AS (
    SELECT a.canonical_module, a.alias_feature
    FROM public.permission_module_aliases a
    WHERE a.alias_module = _module
  ),
  base AS (
    SELECT
      COALESCE((SELECT canonical_module FROM al), _module) AS m,
      CASE
        WHEN position('.' in _action) > 0 THEN split_part(_action, '.', 1)
        WHEN COALESCE(_feature, '*') <> '*' THEN _feature
        ELSE COALESCE((SELECT alias_feature FROM al), '*')
      END AS f,
      CASE WHEN position('.' in _action) > 0
        THEN substring(_action from position('.' in _action) + 1)
        ELSE _action END AS a
  ),
  alias AS (
    SELECT k.canonical_module, k.canonical_feature, k.canonical_action
    FROM public.permission_key_aliases k
    WHERE k.alias_module = _module
      AND k.alias_action = _action
      AND COALESCE(_feature, '*') = '*'
  )
  SELECT
    COALESCE((SELECT canonical_module FROM alias), base.m),
    COALESCE((SELECT canonical_feature FROM alias), base.f),
    COALESCE((SELECT canonical_action FROM alias), base.a)
  FROM base;
$$;

revoke execute on function public.canonical_permission(text,text,text) from public, anon;
grant execute on function public.canonical_permission(text,text,text) to authenticated, service_role;

insert into public.permissions (module, feature, action, label)
select distinct c.module, c.feature, c.action,
       initcap(replace(c.action,'_',' ')) || ' ' || replace(c.feature,'-',' ') || ' (' || c.module || ')'
from public.role_permission_templates t
cross join lateral public.canonical_permission(t.module, '*', t.action) c
where t.version = 1
  and not exists (
    select 1 from public.permissions p
    where p.module = c.module and p.feature = c.feature and p.action = c.action);