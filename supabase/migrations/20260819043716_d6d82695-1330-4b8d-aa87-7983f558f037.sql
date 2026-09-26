-- Stage 7 completion: existing staff roles must actually receive effective access.
-- Additive only: no role, permission or grant is removed.

-- 1) Alias template so the "Waiter / Waitress" role name resolves to the Waiter template.
insert into public.role_permission_templates (version, template_name, template_key, module, action)
select t.version, 'Waiter / Waitress', 'waiter / waitress', t.module, t.action
from public.role_permission_templates t
where t.version = 1 and t.template_key = 'waiter'
  and not exists (
    select 1 from public.role_permission_templates x
    where x.version = 1 and x.template_key = 'waiter / waitress'
      and x.module = t.module and x.action = t.action
  );

-- 2) Backfill every organization role that currently holds zero permissions
--    from its versioned recommended template. Customer-facing roles (Guest)
--    have no staff template and are intentionally left with no staff access.
insert into public.role_permissions (organization_id, role_id, permission_id)
select r.organization_id, r.id, p.id
from public.roles r
join public.role_permission_templates t
  on t.version = 1 and t.template_key = lower(btrim(r.name))
join public.permissions p
  on p.module = t.module and p.action = t.action
where not exists (select 1 from public.role_permissions rp where rp.role_id = r.id)
  and not exists (
    select 1 from public.role_permissions rp2
    where rp2.role_id = r.id and rp2.permission_id = p.id
  );

-- 3) Audit the structural backfill against each affected organization.
insert into public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
select r.organization_id, null, 'NEØ structural repair', 'role.permissions.apply_recommended',
       'administration', r.id,
       jsonb_build_object('role', r.name, 'template_version', 1,
                          'granted', count(rp.id), 'source', 'master-structural-repair')
from public.roles r
join public.role_permissions rp on rp.role_id = r.id
join public.role_permission_templates t
  on t.version = 1 and t.template_key = lower(btrim(r.name))
where rp.created_at > now() - interval '1 minute'
group by r.organization_id, r.id, r.name;