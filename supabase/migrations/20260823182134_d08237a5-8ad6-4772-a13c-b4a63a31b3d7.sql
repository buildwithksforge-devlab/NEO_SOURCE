-- ROLE ISOLATION REPAIR 2: replace coarse module-wide templates with
-- feature-scoped job authority for Rider, Delivery Manager and Procurement.

delete from public.role_permission_templates where version = 1 and template_key = 'rider';
insert into public.role_permission_templates (template_name, template_key, module, action)
select 'Rider', 'rider', m, a from (values
  ('delivery','rider.assignment.view'),('delivery','rider.assignment.accept'),
  ('delivery','rider.assignment.reject'),('delivery','rider.start'),
  ('delivery','rider.pickup'),('delivery','rider.attempt'),('delivery','rider.proof'),
  ('delivery','rider.confirm'),('delivery','rider.cash'),('delivery','rider.availability'),
  ('delivery','rider.issue'),('delivery','orders.view-own'),('delivery','payments.cod'),
  ('notifications','view'),('dashboards','view'),
  ('hr-leave','apply'),('hr-leave','self.view'),('hr-attendance','self.clock'),
  ('hr-attendance','self.view'),('hr-employees','profile.view'),('hr-scheduling','self.view')
) as v(m,a);

delete from public.role_permission_templates where version = 1
  and template_key in ('delivery-manager','delivery manager');
insert into public.role_permission_templates (template_name, template_key, module, action)
select 'Delivery Manager', 'delivery-manager', m, a from (values
  ('delivery','dispatch.view'),('delivery','dispatch.assign'),('delivery','dispatch.reassign'),
  ('delivery','dispatch.eta'),('delivery','dispatch.rider-location'),
  ('delivery','dispatch.contact-customer'),('delivery','dispatch.contact-rider'),
  ('delivery','dispatch.issue-record'),('delivery','dispatch.issue-resolve'),
  ('delivery','orders.view'),('delivery','orders.accept'),('delivery','orders.reject'),
  ('delivery','orders.cancel'),('delivery','orders.update'),('delivery','orders.contact'),
  ('delivery','orders.create-assisted'),('delivery','orders.financials'),
  ('delivery','riders.manage'),('delivery','zones.view'),('delivery','zones.manage'),
  ('delivery','fees.manage'),('delivery','promotions.view'),('delivery','promotions.manage'),
  ('delivery','promotions.performance'),('delivery','payments.view'),('delivery','payments.cod'),
  ('delivery','payments.reconcile'),('delivery','payments.refund-request'),
  ('delivery','payments.revenue'),('delivery','reports.view'),('delivery','reports.export'),
  ('delivery','reports.print'),('delivery','settings.manage'),('delivery','area.override'),
  ('restaurant','orders.view'),
  ('reports','view'),('reports','export'),('reports','print'),
  ('notifications','view'),('dashboards','view'),('dashboards','customize'),
  ('approvals','create'),('approvals','view'),
  ('tasks','view'),('tasks','create'),('tasks','edit'),
  ('hr-leave','apply'),('hr-leave','self.view'),('hr-attendance','self.clock'),
  ('hr-attendance','self.view'),('hr-employees','profile.view'),('hr-scheduling','team.view')
) as v(m,a);

-- Procurement must not inherit the general ledger through a module-wide finance grant.
delete from public.role_permission_templates
 where version = 1 and template_key in ('procurement-manager','procurement-officer')
   and module = 'finance' and action = 'view';
insert into public.role_permission_templates (template_name, template_key, module, action)
select t.template_name, t.template_key, v.m, v.a
from (select distinct template_name, template_key from public.role_permission_templates
       where version = 1 and template_key in ('procurement-manager','procurement-officer')) t,
     (values ('finance-ap','view'),('finance-reports','view')) as v(m,a)
where not exists (
  select 1 from public.role_permission_templates x
  where x.version = 1 and x.template_key = t.template_key and x.module = v.m and x.action = v.a);

-- Front-office and finance roles must not gain campaign authoring rights.
delete from public.role_permission_templates
 where version = 1
   and module = 'marketing'
   and action in ('create','edit','export','print','approve','override','void','reject','delete')
   and template_key in ('receptionist','front-office-supervisor','front-office-cashier',
                        'front office manager','finance-manager','finance manager','accountant',
                        'night-auditor','reservations-agent');

insert into public.permissions (module, feature, action, label)
select distinct c.module, c.feature, c.action,
       initcap(replace(c.action,'_',' ')) || ' ' || replace(c.feature,'-',' ') || ' (' || c.module || ')'
from public.role_permission_templates t
cross join lateral public.canonical_permission(t.module, '*', t.action) c
where t.version = 1
  and not exists (select 1 from public.permissions p
                  where p.module = c.module and p.feature = c.feature and p.action = c.action);

-- Recompile every tenant from the corrected templates.
do $$
declare o record; res jsonb;
begin
  perform set_config('neo.internal','on', true);
  for o in select id from public.organizations loop
    res := public.neo_apply_role_templates(o.id, true);
  end loop;
end $$;