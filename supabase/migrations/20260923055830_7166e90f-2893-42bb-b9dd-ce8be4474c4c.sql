create or replace function public.neo_staff_assignment_save(
  _user uuid,
  _job_title text,
  _employment_status text,
  _branch uuid,
  _department uuid,
  _role_ids uuid[],
  _station uuid,
  _reporting_manager uuid default null,
  _set_reporting_manager boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _org uuid;
  _target_org uuid;
  _before jsonb;
  _after jsonb;
begin
  if not public.has_permission('administration','users','edit') then
    raise exception 'Not authorised to edit staff assignments' using errcode = '42501';
  end if;

  select organization_id into _org from public.profiles where id = auth.uid();
  if _org is null then
    raise exception 'No organisation context' using errcode = '42501';
  end if;

  select organization_id into _target_org from public.profiles where id = _user;
  if _target_org is null or _target_org <> _org then
    raise exception 'User not found in your organisation' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'branch_id', p.branch_id,
    'department_id', p.department_id,
    'job_title', p.job_title,
    'employment_status', p.employment_status,
    'reporting_manager_id', p.reporting_manager_id,
    'role_ids', coalesce((select jsonb_agg(ur.role_id order by ur.role_id) from public.user_roles ur where ur.user_id = _user and ur.organization_id = _org), '[]'::jsonb),
    'station_ids', coalesce((select jsonb_agg(us.station_id order by us.station_id) from public.user_stations us where us.user_id = _user and us.organization_id = _org), '[]'::jsonb)
  ) into _before
  from public.profiles p where p.id = _user;

  update public.profiles
     set job_title = coalesce(_job_title, job_title),
         employment_status = coalesce(_employment_status, employment_status),
         branch_id = _branch,
         department_id = _department,
         reporting_manager_id = case when _set_reporting_manager then _reporting_manager else reporting_manager_id end
   where id = _user and organization_id = _org;

  delete from public.user_roles where user_id = _user and organization_id = _org;
  if _role_ids is not null and array_length(_role_ids, 1) > 0 then
    insert into public.user_roles (organization_id, user_id, role_id)
    select _org, _user, x from unnest(_role_ids) x
    on conflict do nothing;
  end if;

  delete from public.user_branches where user_id = _user and organization_id = _org;
  if _branch is not null then
    insert into public.user_branches (organization_id, user_id, branch_id)
    values (_org, _user, _branch) on conflict do nothing;
  end if;

  delete from public.user_departments where user_id = _user and organization_id = _org;
  if _department is not null then
    insert into public.user_departments (organization_id, user_id, department_id)
    values (_org, _user, _department) on conflict do nothing;
  end if;

  delete from public.user_stations where user_id = _user and organization_id = _org;
  if _station is not null then
    insert into public.user_stations (organization_id, user_id, station_id, branch_id, is_primary, created_by)
    values (_org, _user, _station, _branch, true, auth.uid()) on conflict do nothing;
  end if;

  select jsonb_build_object(
    'branch_id', p.branch_id,
    'department_id', p.department_id,
    'job_title', p.job_title,
    'employment_status', p.employment_status,
    'reporting_manager_id', p.reporting_manager_id,
    'role_ids', coalesce((select jsonb_agg(ur.role_id order by ur.role_id) from public.user_roles ur where ur.user_id = _user and ur.organization_id = _org), '[]'::jsonb),
    'station_ids', coalesce((select jsonb_agg(us.station_id order by us.station_id) from public.user_stations us where us.user_id = _user and us.organization_id = _org), '[]'::jsonb)
  ) into _after
  from public.profiles p where p.id = _user;

  return jsonb_build_object('before', _before, 'after', _after);
end;
$$;

revoke all on function public.neo_staff_assignment_save(uuid,text,text,uuid,uuid,uuid[],uuid,uuid,boolean) from public;
grant execute on function public.neo_staff_assignment_save(uuid,text,text,uuid,uuid,uuid[],uuid,uuid,boolean) to authenticated;