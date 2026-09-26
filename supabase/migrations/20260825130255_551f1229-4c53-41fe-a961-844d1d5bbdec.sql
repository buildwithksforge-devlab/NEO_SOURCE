-- Daily revenue must be bucketed in the property's local day, exactly as the
-- posting queue and Finance already do. Amounts are unchanged.
create or replace function public.bi_revenue_series(
  _branch uuid default null, _from date default null, _to date default null
)
returns table(day date, rooms numeric, fnb numeric, delivery numeric, events numeric, posted numeric)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare _org uuid := public.bi_guard();
  f date := coalesce(_from, current_date - 29);
  t date := coalesce(_to, current_date);
  tz text;
begin
  perform public.neo_assert_reporting_scope(_branch, _from, _to);
  tz := public.neo_fact_timezone(_org, _branch);
  return query
  with d as (select generate_series(f, t, interval '1 day')::date as day)
  select d.day,
    coalesce((select sum(fl.net_amount) from public.folio_lines fl
       where fl.organization_id = _org and (_branch is null or fl.branch_id = _branch)
         and coalesce(fl.status,'posted') <> 'void'
         and (lower(coalesce(fl.line_type,'')) like '%room%' or lower(coalesce(fl.category,'')) like '%room%')
         and coalesce(fl.operational_date, fl.posting_date::date) = d.day), 0)::numeric,
    coalesce((select sum(o.grand_total) from public.pos_orders o
       where o.organization_id = _org and (_branch is null or o.branch_id = _branch)
         and o.status in ('closed','paid','settled','completed')
         and (o.created_at at time zone tz)::date = d.day), 0)::numeric,
    coalesce((select sum(dl.grand_total) from public.delivery_orders dl
       where dl.organization_id = _org and (_branch is null or dl.branch_id = _branch)
         and dl.order_status = 'delivered'
         and (dl.created_at at time zone tz)::date = d.day), 0)::numeric,
    coalesce((select sum(e.total_amount) from public.event_bookings e
       where e.organization_id = _org and (_branch is null or e.branch_id = _branch)
         and e.status in ('confirmed','completed') and e.event_date = d.day), 0)::numeric,
    coalesce((select sum(l.credit - l.debit) from public.journal_entry_lines l
       join public.journal_entries j on j.id = l.journal_id
       join public.chart_of_accounts a on a.id = l.account_id
       where j.organization_id = _org and j.status = 'posted'
         and (_branch is null or j.branch_id = _branch)
         and (lower(coalesce(a.category,a.account_group,'')) like '%revenue%'
              or lower(coalesce(a.category,a.account_group,'')) like '%income%')
         and j.accounting_date = d.day), 0)::numeric
  from d order by d.day;
end; $function$;

revoke execute on function public.bi_revenue_series(uuid, date, date) from public, anon;
grant execute on function public.bi_revenue_series(uuid, date, date) to authenticated, service_role;

-- Same correction inside the KPI function, applied to its existing definition
-- so no other logic in it changes.
do $do$
declare src text; newdef text;
begin
  select pg_get_functiondef(oid) into src from pg_proc
   where proname = 'bi_kpis' and pronamespace = 'public'::regnamespace limit 1;
  if src is null then return; end if;

  newdef := replace(src, 'AND o.created_at::date BETWEEN f AND t',
                         'AND (o.created_at AT TIME ZONE public.neo_fact_timezone(_org, _branch))::date BETWEEN f AND t');
  newdef := replace(newdef, 'AND d.created_at::date BETWEEN f AND t',
                            'AND (d.created_at AT TIME ZONE public.neo_fact_timezone(_org, _branch))::date BETWEEN f AND t');

  if newdef <> src then
    execute newdef;
  end if;
end $do$;