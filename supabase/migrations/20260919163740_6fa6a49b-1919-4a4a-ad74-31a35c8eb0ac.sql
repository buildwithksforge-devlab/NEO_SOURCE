create table if not exists public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  membership_type text not null default 'staff' check (membership_type in ('staff','external')),
  status text not null default 'active' check (status in ('active','suspended','invited')),
  invited_by uuid references public.profiles(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, organization_id)
);

create index if not exists organization_memberships_org_idx on public.organization_memberships (organization_id, status);
create index if not exists organization_memberships_user_idx on public.organization_memberships (user_id, status);

grant select on public.organization_memberships to authenticated;
grant all on public.organization_memberships to service_role;

alter table public.organization_memberships enable row level security;

create or replace function public.neo_membership_touch()
returns trigger language plpgsql set search_path = public
as $$ begin new.updated_at = now(); return new; end; $$;

create trigger organization_memberships_touch
  before update on public.organization_memberships
  for each row execute function public.neo_membership_touch();

-- Every existing person keeps exactly the group they already had.
insert into public.organization_memberships (user_id, organization_id, membership_type, status)
select p.id, p.organization_id, 'staff',
       case when p.account_status = 'active' then 'active' else 'suspended' end
  from public.profiles p
 where p.organization_id is not null
   and p.account_type in ('staff','platform_admin')
on conflict (user_id, organization_id) do nothing;

-- The group a person is currently working in.
alter table public.profiles
  add column if not exists active_organization_id uuid references public.organizations(id) on delete set null;

-- Membership lookup used by the access rules below; kept separate so the
-- policies never read the table they protect.
create or replace function public.neo_is_member_of(_org uuid, _user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.organization_memberships m
     where m.organization_id = _org and m.user_id = _user and m.status = 'active'
  );
$$;

revoke execute on function public.neo_is_member_of(uuid, uuid) from anon, public;
grant execute on function public.neo_is_member_of(uuid, uuid) to authenticated;

create policy "People read their own memberships"
  on public.organization_memberships for select to authenticated
  using (user_id = auth.uid());

create policy "Administrators read memberships of their workspace"
  on public.organization_memberships for select to authenticated
  using (is_org_admin_for(organization_id));

-- The workspace a caller is acting in: their selected group when they are an
-- active member of it, otherwise the group on their profile. Behaviour for a
-- person with a single membership is unchanged.
create or replace function public.current_org_id()
returns uuid
language sql stable security definer set search_path = public
as $$
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
    -- Trusted system context only: never applies to a signed-in caller.
    CASE WHEN auth.uid() IS NULL
      THEN nullif(current_setting('neo.system_org', true), '')::uuid END
  );
$$;

-- Property access must belong to the workspace being worked in.
create or replace function public.current_branch_ids()
returns uuid[]
language sql stable security definer set search_path = public
as $$
  SELECT coalesce(array_agg(DISTINCT s.b), '{}'::uuid[])
    FROM (
      SELECT ub.branch_id AS b FROM public.user_branches ub
        WHERE ub.user_id = auth.uid() AND ub.branch_id IS NOT NULL
      UNION
      SELECT p.branch_id FROM public.profiles p
        WHERE p.id = auth.uid() AND p.branch_id IS NOT NULL
    ) s
    JOIN public.branches br ON br.id = s.b
   WHERE br.organization_id = public.current_org_id();
$$;

-- The groups I belong to.
create or replace function public.neo_my_workspaces()
returns table (
  organization_id uuid,
  organization_name text,
  membership_type text,
  status text,
  is_current boolean
)
language sql stable security definer set search_path = public
as $$
  select o.id, o.name, m.membership_type, m.status,
         o.id = public.current_org_id()
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id
   where m.user_id = auth.uid() and m.status = 'active'
   order by o.name;
$$;

revoke execute on function public.neo_my_workspaces() from anon, public;
grant execute on function public.neo_my_workspaces() to authenticated;

-- Switch the group I am working in.
create or replace function public.neo_switch_workspace(_org uuid)
returns uuid
language plpgsql volatile security definer set search_path = public
as $$
begin
  if _org is null then
    raise exception 'Select a workspace to switch to.';
  end if;
  if not public.neo_is_member_of(_org, auth.uid()) then
    raise exception 'You are not an active member of that workspace.';
  end if;
  update public.profiles
     set active_organization_id = _org
   where id = auth.uid();
  return _org;
end;
$$;

revoke execute on function public.neo_switch_workspace(uuid) from anon, public;
grant execute on function public.neo_switch_workspace(uuid) to authenticated;

-- Invite an existing person into my workspace, or change their membership.
create or replace function public.neo_membership_set(
  _user uuid,
  _org uuid,
  _membership_type text default 'staff',
  _status text default 'active',
  _note text default null
)
returns uuid
language plpgsql volatile security definer set search_path = public
as $$
declare _id uuid;
begin
  if not public.is_org_admin_for(_org) then
    raise exception 'Only an administrator of that workspace can manage its memberships.';
  end if;
  if _membership_type not in ('staff','external') then
    raise exception 'Membership type must be staff or external.';
  end if;
  if _status not in ('active','suspended','invited') then
    raise exception 'Membership status must be active, suspended or invited.';
  end if;
  if not exists (select 1 from public.profiles p where p.id = _user) then
    raise exception 'That person does not exist.';
  end if;

  insert into public.organization_memberships (user_id, organization_id, membership_type, status, invited_by, note)
  values (_user, _org, _membership_type, _status, auth.uid(), _note)
  on conflict (user_id, organization_id) do update
    set membership_type = excluded.membership_type,
        status = excluded.status,
        note = coalesce(excluded.note, public.organization_memberships.note)
  returning id into _id;

  return _id;
end;
$$;

revoke execute on function public.neo_membership_set(uuid, uuid, text, text, text) from anon, public;
grant execute on function public.neo_membership_set(uuid, uuid, text, text, text) to authenticated;

-- Remove a membership. A person can never be left with none, and the workspace
-- on their profile is never removed here.
create or replace function public.neo_membership_remove(_user uuid, _org uuid)
returns boolean
language plpgsql volatile security definer set search_path = public
as $$
declare _remaining integer;
begin
  if not public.is_org_admin_for(_org) then
    raise exception 'Only an administrator of that workspace can manage its memberships.';
  end if;
  if exists (select 1 from public.profiles p where p.id = _user and p.organization_id = _org) then
    raise exception 'This is the person''s home workspace and cannot be removed here.';
  end if;

  delete from public.organization_memberships
   where user_id = _user and organization_id = _org;

  select count(*) into _remaining
    from public.organization_memberships
   where user_id = _user and status = 'active';
  if _remaining = 0 then
    raise exception 'A person must keep at least one workspace.';
  end if;

  update public.profiles
     set active_organization_id = null
   where id = _user and active_organization_id = _org;

  return true;
end;
$$;

revoke execute on function public.neo_membership_remove(uuid, uuid) from anon, public;
grant execute on function public.neo_membership_remove(uuid, uuid) to authenticated;