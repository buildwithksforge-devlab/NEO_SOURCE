-- Keep future audit partitions ready ahead of time.
create or replace function public.neo_audit_maintain_partitions(_months_ahead integer default 3)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  _m integer;
  _start date;
  _made text[] := '{}';
  _name text;
begin
  if auth.role() is distinct from 'service_role' and not coalesce(public.is_org_admin(), false) then
    raise exception 'Not permitted to maintain audit partitions';
  end if;

  for _m in 0.._months_ahead loop
    _start := date_trunc('month', now())::date + (_m || ' months')::interval;
    _name := 'audit_logs_p' || to_char(_start, 'YYYYMM');
    if to_regclass('public.' || _name) is null then
      execute format(
        'create table public.%I partition of public.audit_logs for values from (%L) to (%L)',
        _name, _start, (_start + interval '1 month')::date
      );
      execute format(
        'create index if not exists %I on public.%I (organization_id, created_at desc)',
        _name || '_organization_id_created_at_idx', _name
      );
      _made := _made || _name;
    end if;
  end loop;

  return _made;
end;
$$;

revoke all on function public.neo_audit_maintain_partitions(integer) from public, anon;
grant execute on function public.neo_audit_maintain_partitions(integer) to authenticated, service_role;

-- Read-only retention status: what exists, how old, and whether it may be archived yet.
create or replace function public.neo_retention_status()
returns table (
  table_name text,
  record_class text,
  retention_months integer,
  archive_destination text,
  legal_hold boolean,
  approved boolean,
  cutoff timestamptz,
  eligible boolean,
  status text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_org_admin(), false) and auth.role() is distinct from 'service_role' then
    raise exception 'Not permitted to read the retention register';
  end if;

  return query
  select
    r.table_name,
    r.record_class,
    r.retention_months,
    r.archive_destination,
    r.legal_hold,
    (r.approved_by is not null and r.approved_at is not null) as approved,
    case when r.retention_months is null then null
         else now() - make_interval(months => r.retention_months) end as cutoff,
    (
      r.retention_months is not null
      and r.archive_destination is not null
      and r.approved_by is not null
      and r.approved_at is not null
      and not r.legal_hold
    ) as eligible,
    case
      when r.legal_hold then 'Held — legal hold in force'
      when r.retention_months is null then 'Not configured — no retention period approved'
      when r.archive_destination is null then 'Not configured — no archive destination recorded'
      when r.approved_by is null or r.approved_at is null then 'Awaiting approval'
      else 'Approved — archiving may proceed'
    end as status
  from public.records_retention_register r
  order by r.table_name;
end;
$$;

revoke all on function public.neo_retention_status() from public, anon;
grant execute on function public.neo_retention_status() to authenticated, service_role;