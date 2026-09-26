-- Posted GL and emitted domain events are immutable history; a guest merge must
-- not rewrite them. They stay resolvable through customers.merged_into_id.
create or replace function public.neo_customer_merge(
  _surviving uuid, _duplicate uuid, _reason text default 'duplicate guest profile'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare s public.customers; d public.customers; r record; moved jsonb := '{}'::jsonb; n int;
  immutable_tables text[] := array['journal_entry_lines','domain_events','customer_merge_history','audit_logs'];
begin
  if not (public.is_org_admin() or has_permission('marketing','customers','edit')) then
    raise exception 'Missing permission: marketing.customers.edit';
  end if;
  select * into s from public.customers where id = _surviving;
  select * into d from public.customers where id = _duplicate;
  if s.id is null or d.id is null then raise exception 'Guest profile not found'; end if;
  if s.id = d.id then raise exception 'Cannot merge a guest into itself'; end if;
  if s.organization_id <> d.organization_id or s.organization_id <> current_org_id() then
    raise exception 'Not permitted';
  end if;
  if d.merged_into_id is not null then
    return jsonb_build_object('ok', true, 'already_merged', true, 'surviving', d.merged_into_id);
  end if;

  for r in
    select cl.relname as tbl, a.attname as col
      from pg_constraint k
      join pg_class cl on cl.oid = k.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      join pg_attribute a on a.attrelid = cl.oid and a.attnum = k.conkey[1]
     where k.contype = 'f' and k.confrelid = 'public.customers'::regclass
       and array_length(k.conkey,1) = 1
       and ns.nspname = 'public'
       and cl.relname <> 'customers'
       and not (cl.relname = any (immutable_tables))
  loop
    begin
      execute format('update public.%I set %I = $1 where %I = $2', r.tbl, r.col, r.col)
        using s.id, d.id;
      get diagnostics n = row_count;
      if n > 0 then moved := moved || jsonb_build_object(r.tbl || '.' || r.col, n); end if;
    exception when unique_violation then
      execute format('delete from public.%I where %I = $1', r.tbl, r.col) using d.id;
    end;
  end loop;

  update public.customers set
    merged_into_id = s.id,
    account_status = 'merged',
    archived_at = now(),
    updated_at = now()
  where id = d.id;

  update public.customers set
    phone = case when phone = '' then d.phone else phone end,
    email = case when email = '' then d.email else email end,
    is_vip = is_vip or d.is_vip,
    primary_branch_id = coalesce(primary_branch_id, d.primary_branch_id),
    updated_at = now()
  where id = s.id;

  insert into public.customer_merge_history (organization_id, surviving_customer_id, merged_customer_id, reason, snapshot, performed_by)
  values (s.organization_id, s.id, d.id, _reason, jsonb_build_object('duplicate', to_jsonb(d), 'moved', moved), auth.uid());

  return jsonb_build_object('ok', true, 'surviving', s.id, 'merged', d.id, 'moved', moved);
end $$;