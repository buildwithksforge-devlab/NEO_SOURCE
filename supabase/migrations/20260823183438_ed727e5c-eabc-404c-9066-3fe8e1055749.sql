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

  if v_id is null and v_phone is not null then
    select id into v_id from public.customers
     where organization_id = _org and merged_into_id is null
       and phone <> ''
       and regexp_replace(phone,'[^0-9+]','','g') = regexp_replace(v_phone,'[^0-9+]','','g')
     limit 1;
  end if;
  if v_id is null and v_email is not null then
    select id into v_id from public.customers
     where organization_id = _org and merged_into_id is null
       and email <> '' and lower(email) = v_email
     limit 1;
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
          public.next_document_number('customer', 'GST', _branch),
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