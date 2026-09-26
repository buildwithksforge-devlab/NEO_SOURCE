-- Hot-Kitchen Chef needs read-only visibility of the stock his own station consumes.
insert into public.role_permissions_base (organization_id, role_id, permission_id, source)
select r.organization_id, r.id, '8aad4ab0-3c53-4681-9f16-c2620baf0a42'::uuid, 'template'
from public.roles r
where r.id = '14a7775b-7255-4c42-9778-647c7556d2a7'
  and not exists (
    select 1 from public.role_permissions_base b
    where b.role_id = r.id and b.permission_id = '8aad4ab0-3c53-4681-9f16-c2620baf0a42'::uuid
  );