-- 2) Canonical revenue variance: operations vs Finance, with the reason for any gap
create or replace function public.neo_revenue_reconciliation(
  _branch uuid default null, _from date default null, _to date default null
)
returns table(
  module text,
  operational_amount numeric,
  posted_amount numeric,
  variance numeric,
  awaiting_amount numeric,
  blocked_amount numeric,
  failed_amount numeric,
  explanation text
)
language plpgsql
stable security definer
set search_path to 'public'
as $$
declare org uuid := public.current_org_id(); tz text; f date; t date;
begin
  if org is null or not (public.is_org_admin() or public.has_permission('finance','view')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  tz := public.neo_fact_timezone(org, _branch);
  t := coalesce(_to, (now() at time zone tz)::date);
  f := coalesce(_from, t - 29);

  return query
  with q as (
    select public.neo_module_label(k.source_module) as m,
           sum(k.amount) as source_amount,
           sum(k.amount) filter (where k.eligible) as awaiting,
           sum(k.amount) filter (where not k.eligible) as blocked
      from public.neo_finance_posting_queue(_branch, f, t) k
     group by 1
  ), r as (
    select public.neo_module_label(x.source_module) as m,
           sum(x.amount) filter (where x.status = 'failed') as failed
      from public.finance_posting_receipts x
     where x.organization_id = org
       and (_branch is null or x.branch_id = _branch)
       and coalesce(x.occurred_on, (x.created_at at time zone tz)::date) between f and t
     group by 1
  ), g as (
    select public.neo_module_label(j.source_module) as m,
           sum(l.credit - l.debit) as posted
      from public.journal_entries j
      join public.journal_entry_lines l on l.journal_id = j.id
      join public.chart_of_accounts c on c.id = l.account_id
     where j.organization_id = org
       and j.status = 'posted'
       and (_branch is null or j.branch_id = _branch)
       and j.accounting_date between f and t
       and c.category in ('revenue','other_income')
     group by 1
  ), joined as (
    select coalesce(q.m, r.m, g.m)::text as m,
           coalesce(q.source_amount, 0)::numeric(18,2) as src,
           coalesce(g.posted, 0)::numeric(18,2) as pst,
           coalesce(q.awaiting, 0)::numeric(18,2) as await_amt,
           coalesce(q.blocked, 0)::numeric(18,2) as blk,
           coalesce(r.failed, 0)::numeric(18,2) as fail
      from q
      full outer join r on r.m = q.m
      full outer join g on g.m = coalesce(q.m, r.m)
  )
  select j.m,
         j.src, j.pst, (j.src - j.pst)::numeric(18,2),
         j.await_amt, j.blk, j.fail,
         case
           when abs(j.src - j.pst) < 0.01 then 'Reconciled — operations and Finance agree.'
           else trim(both ' ' from concat_ws(' ',
             case when j.await_amt > 0 then 'Awaiting posting: ' || to_char(j.await_amt, 'FM999,999,999.00') || '.' end,
             case when j.blk > 0 then 'Blocked by a posting rule: ' || to_char(j.blk, 'FM999,999,999.00') || '.' end,
             case when j.fail > 0 then 'Failed postings needing retry: ' || to_char(j.fail, 'FM999,999,999.00') || '.' end,
             case when j.await_amt = 0 and j.blk = 0 and j.fail = 0
                  then 'Difference sits outside the posting queue — review the period and source records.' end))
         end::text
    from joined j
   order by 1;
end $$;

revoke execute on function public.neo_revenue_reconciliation(uuid, date, date) from public, anon;
grant execute on function public.neo_revenue_reconciliation(uuid, date, date) to authenticated, service_role;
