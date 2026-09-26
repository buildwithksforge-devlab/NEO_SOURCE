-- CRM REPAIR 1: one unified guest profile — resolve before insert, and a
-- catalog-driven merge that repoints every reference to the surviving guest.

create or replace function public.neo_customer_resolve(
  _org uuid,
  _branch uuid,
  _full_name text,
  _phone text default null,
  _email text default null,
  _identifier_type text default null,
  _identifier_value text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid; v_phone text := nullif(btrim(coalesce(_phone,'')),''); v_email text := lower(nullif(btrim(coalesce(_email,'')),''));
begin
  if _org is null or _org <> coalesce(current_org_id(), _org) then
    raise exception 'Not permitted';
  end if;
  if not (public.neo_system_posting() or public.is_staff()) then
    raise exception 'Not permitted';
  end if;

  -- 1. strongest signal: a government/loyalty identifier
  if _identifier_value is not null and btrim(_identifier_value) <> '' then
    select ci.customer_id into v_id
      from public.customer_identifiers ci
      join public.customers c on c.id = ci.customer_id
     where c.organization_id = _org
       and c.merged_into_id is null
       and lower(ci.identifier_value) = lower(btrim(_identifier_value))
       and (_identifier_type is null or ci.identifier_type = _identifier_type)
     limit 1;
  end if;

  -- 2. phone, then email, within the tenant
  if v_id is null and v_phone is not null then
    select id into v_id from public.customers
     where organization_id = _org and merged_into_id is null
       and regexp_replace(phone,'[^0-9+]','','g') = regexp_replace(v_phone,'[^0-9+]','','g')
       and phone <> '' limit 1;
  end if;
  if v_id is null and v_email is not null then
    select id into v_id from public.customers
     where organization_id = _org and merged_into_id is null
       and lower(email) = v_email and email <> '' limit 1;
  end if;

  if v_id is not null then
    update public.customers set
      full_name = case when btrim(coalesce(_full_name,'')) = '' then full_name else _full_name end,
      phone = case when phone = '' and v_phone is not null then v_phone else phone end,
      email = case when email = '' and v_email is not null then v_email else email end,
      primary_branch_id = coalesce(primary_branch_id, _branch),
      last_interaction_at = now(),
      updated_at = now()
    where id = v_id;
    return v_id;
  end if;

  insert into public.customers (organization_id, primary_branch_id, customer_number, full_name, phone, email, created_by)
  values (_org, _branch,
          public.next_document_number(_org, 'customer'),
          coalesce(nullif(btrim(_full_name),''),'Guest'),
          coalesce(v_phone,''), coalesce(v_email,''), auth.uid())
  returning id into v_id;

  if _identifier_value is not null and btrim(_identifier_value) <> '' then
    insert into public.customer_identifiers (organization_id, customer_id, identifier_type, identifier_value)
    values (_org, v_id, coalesce(_identifier_type,'other'), btrim(_identifier_value))
    on conflict do nothing;
  end if;

  return v_id;
end $$;

create or replace function public.neo_customer_merge(
  _surviving uuid, _duplicate uuid, _reason text default 'duplicate guest profile'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare s public.customers; d public.customers; r record; moved jsonb := '{}'::jsonb; n int;
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
       and not (cl.relname = 'customers')
       and not (cl.relname = 'customer_merge_history')
  loop
    begin
      execute format('update public.%I set %I = $1 where %I = $2', r.tbl, r.col, r.col)
        using s.id, d.id;
      get diagnostics n = row_count;
      if n > 0 then moved := moved || jsonb_build_object(r.tbl || '.' || r.col, n); end if;
    exception when unique_violation then
      -- the surviving guest already owns an equivalent row; drop the duplicate link
      execute format('delete from public.%I where %I = $1', r.tbl, r.col) using d.id;
    end;
  end loop;

  update public.customers set
    merged_into_id = s.id,
    account_status = 'merged',
    archived_at = now(),
    updated_at = now()
  where id = d.id;

  -- backfill any detail the surviving record is missing
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

revoke all on function public.neo_customer_resolve(uuid,uuid,text,text,text,text,text) from public, anon;
revoke all on function public.neo_customer_merge(uuid,uuid,text) from public, anon;
grant execute on function public.neo_customer_resolve(uuid,uuid,text,text,text,text,text) to authenticated;
grant execute on function public.neo_customer_merge(uuid,uuid,text) to authenticated;