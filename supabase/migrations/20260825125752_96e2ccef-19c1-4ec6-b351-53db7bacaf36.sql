-- 1) Baseline chart of accounts completion (additive only)
create or replace function public.neo_finance_ensure_accounts(_org uuid default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare org uuid := coalesce(_org, public.current_org_id()); added int := 0;
begin
  if org is null or not (public.is_org_admin() or public.has_permission('finance','manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  with baseline(code, name, category, account_group) as (
    values
      ('1000','Assets','asset','Assets'),
      ('1010','Cash on Hand','asset','Cash & Bank'),
      ('1020','Bank Accounts','asset','Cash & Bank'),
      ('1030','M-Pesa Clearing','asset','Cash & Bank'),
      ('1040','Card Clearing','asset','Cash & Bank'),
      ('1050','OTA Receivables','asset','Receivables'),
      ('1060','Accounts Receivable','asset','Receivables'),
      ('1070','Inventory','asset','Inventory'),
      ('2000','Liabilities','liability','Liabilities'),
      ('2010','Accounts Payable','liability','Payables'),
      ('2015','Goods Received Not Invoiced','liability','Payables'),
      ('2020','Guest Deposits','liability','Deposits'),
      ('2030','Event Deposits','liability','Deposits'),
      ('2040','VAT Payable','liability','Tax'),
      ('2050','Service Charge Payable','liability','Tax'),
      ('2060','Customer Credit Balances','liability','Payables'),
      ('3000','Equity','equity','Equity'),
      ('3010','Retained Earnings','equity','Equity'),
      ('4000','Revenue','revenue','Revenue'),
      ('4010','Room Revenue','revenue','Revenue'),
      ('4020','Restaurant Revenue','revenue','Revenue'),
      ('4030','Bar Revenue','revenue','Revenue'),
      ('4040','Room Service Revenue','revenue','Revenue'),
      ('4050','Laundry Revenue','revenue','Revenue'),
      ('4060','Event Revenue','revenue','Revenue'),
      ('4070','Delivery Revenue','revenue','Revenue'),
      ('4080','Transport Revenue','revenue','Revenue'),
      ('4090','Other Revenue','other_income','Revenue'),
      ('4095','Refunds & Revenue Reversals','revenue','Revenue'),
      ('5000','Cost of Sales','cost_of_sales','Cost of Sales'),
      ('5010','Food Cost','cost_of_sales','Cost of Sales'),
      ('5020','Beverage Cost','cost_of_sales','Cost of Sales'),
      ('6000','Operating Expenses','operating_expense','Operating Expenses'),
      ('6090','Bank Charges','operating_expense','Operating Expenses'),
      ('6095','M-Pesa Charges','operating_expense','Operating Expenses'),
      ('6099','Other Operating Expenses','operating_expense','Operating Expenses')
  ), ins as (
    insert into public.chart_of_accounts (organization_id, code, name, category, account_group, is_header, postable, active)
    select org, b.code, b.name, b.category, b.account_group,
           b.code ~ '^\d000$', not (b.code ~ '^\d000$'), true
      from baseline b
     where not exists (
       select 1 from public.chart_of_accounts c
        where c.organization_id = org and c.code = b.code
     )
    returning 1
  )
  select count(*) into added from ins;

  return added;
end $$;

revoke execute on function public.neo_finance_ensure_accounts(uuid) from public, anon;
grant execute on function public.neo_finance_ensure_accounts(uuid) to authenticated, service_role;

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