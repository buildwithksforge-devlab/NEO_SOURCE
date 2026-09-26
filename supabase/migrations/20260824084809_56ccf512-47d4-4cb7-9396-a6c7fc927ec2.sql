CREATE OR REPLACE FUNCTION public.neo_customer_merge(_surviving uuid, _duplicate uuid, _reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.customers; d public.customers; r record; moved jsonb := '{}'::jsonb; n int;
  reason text := nullif(btrim(coalesce(_reason,'')), '');
  prior public.customer_merge_history;
  immutable_tables text[] := array['journal_entry_lines','domain_events','customer_merge_history','audit_logs'];
begin
  -- The catalogued capability for guest profiles is marketing.crm-customers.*;
  -- the legacy 'customers' feature name is still accepted for older grants.
  if not (
    public.is_org_admin()
    or public.has_permission('marketing','crm-customers','edit')
    or public.has_permission('marketing','customers','edit')
  ) then
    raise exception 'Missing permission: marketing.crm-customers.edit';
  end if;

  if reason is null or length(reason) < 5 then
    raise exception 'A merge reason of at least 5 characters is required';
  end if;

  select * into s from public.customers where id = _surviving;
  select * into d from public.customers where id = _duplicate;
  if s.id is null or d.id is null then raise exception 'Guest profile not found'; end if;
  if s.id = d.id then raise exception 'Cannot merge a guest into itself'; end if;
  if s.organization_id <> d.organization_id or s.organization_id <> current_org_id() then
    raise exception 'Not permitted';
  end if;
  if s.merged_into_id is not null then
    raise exception 'The surviving profile has itself been merged already';
  end if;

  if d.merged_into_id is not null then
    return jsonb_build_object('ok', true, 'already_merged', true, 'surviving', d.merged_into_id, 'merged', d.id);
  end if;

  select * into prior from public.customer_merge_history
   where merged_customer_id = d.id order by created_at desc limit 1;
  if prior.id is not null then
    return jsonb_build_object('ok', true, 'already_merged', true, 'surviving', prior.surviving_customer_id, 'merged', d.id);
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
    phone = case when coalesce(btrim(phone),'') = '' then d.phone else phone end,
    email = case when coalesce(btrim(email),'') = '' then d.email else email end,
    is_vip = is_vip or d.is_vip,
    primary_branch_id = coalesce(primary_branch_id, d.primary_branch_id),
    updated_at = now()
  where id = s.id;

  insert into public.customer_merge_history (organization_id, surviving_customer_id, merged_customer_id, reason, snapshot, performed_by)
  values (s.organization_id, s.id, d.id, reason, jsonb_build_object('duplicate', to_jsonb(d), 'surviving_before', to_jsonb(s), 'moved', moved), auth.uid());

  perform public.log_audit_event(
    'crm.customer.merge', 'marketing', s.id::text,
    jsonb_build_object('merged_customer', d.customer_number, 'merged_id', d.id, 'account_status', d.account_status),
    jsonb_build_object('surviving_customer', s.customer_number, 'surviving_id', s.id, 'moved', moved),
    reason, 'marketing.crm-customers.edit', null, null, null, null, null, null
  );

  return jsonb_build_object('ok', true, 'surviving', s.id, 'merged', d.id, 'moved', moved, 'reason', reason);
end $function$;

REVOKE ALL ON FUNCTION public.neo_customer_merge(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_customer_merge(uuid, uuid, text) TO authenticated;