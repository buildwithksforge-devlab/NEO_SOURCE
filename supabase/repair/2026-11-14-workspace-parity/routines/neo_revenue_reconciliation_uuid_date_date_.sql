CREATE OR REPLACE FUNCTION public.neo_revenue_reconciliation(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS TABLE(module text, operational_amount numeric, posted_amount numeric, variance numeric, awaiting_amount numeric, blocked_amount numeric, failed_amount numeric, explanation text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare org uuid := public.current_org_id(); tz text; f date; t date; report_currency text;
begin
  if org is null or not (public.is_org_admin() or public.has_permission('finance','view')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  tz := public.neo_fact_timezone(org, _branch);
  t := coalesce(_to, (now() at time zone tz)::date);
  f := coalesce(_from, t - 29);
  report_currency:=public.neo_fact_currency(org,_branch);
  if nullif(btrim(report_currency),'') is null then raise exception 'Report currency is not configured'; end if;

  -- This contract has no currency column: never add different currencies.
  if exists (
    select 1 from public.pos_orders o where o.organization_id=org
      and (_branch is null or o.branch_id=_branch) and o.folio_id is null
      and o.status in ('closed','paid','settled','completed') and o.currency is distinct from report_currency
      and (coalesce(o.closed_at,o.created_at) at time zone tz)::date between f and t
  ) or exists (
    select 1 from public.folio_lines fl join public.folios fo on fo.id=fl.folio_id and fo.organization_id=fl.organization_id
    where fl.organization_id=org and (_branch is null or fl.branch_id=_branch)
      and fl.status='posted' and coalesce(fl.line_type,'charge')<>'payment'
      and coalesce(fl.operational_date,(fl.posting_date at time zone tz)::date) between f and t
      and fo.currency is distinct from report_currency
  ) or exists (
    select 1 from public.journal_entries j where j.organization_id=org
      and (_branch is null or j.branch_id=_branch) and j.status='posted'
      and j.accounting_date between f and t and j.currency is distinct from report_currency
  ) then raise exception 'Revenue report contains currencies different from %. Filter to one currency/property or configure verified conversion.',report_currency; end if;

  return query
  with source_rows as (
    -- Finalised standalone sales are revenue; room transfers are recognised on folio charges.
    select 'pos'::text as m,o.id as source_id,'pos_order:revenue'::text as source_type,
      (coalesce(o.grand_total,0)-coalesce(o.tax_total,0)-coalesce(o.service_charge_total,0))::numeric as net,
      o.branch_id
    from public.pos_orders o
    where o.organization_id=org
      and (_branch is null or o.branch_id=_branch) and o.folio_id is null
      and o.status in ('closed','paid','settled','completed')
      and (coalesce(o.closed_at,o.created_at) at time zone tz)::date between f and t
    union all
    select 'folio',fl.id,'folio_charge:revenue',
      (coalesce(fl.gross_amount,0)-coalesce(fl.discount_amount,0))::numeric,fl.branch_id
    from public.folio_lines fl
    where fl.organization_id=org
      and (_branch is null or fl.branch_id=_branch) and fl.status='posted'
      and coalesce(fl.line_type,'charge')<>'payment'
      and coalesce(fl.operational_date,(fl.posting_date at time zone tz)::date) between f and t
  ), source_evidence as (
    select s.*,exists(select 1 from public.journal_entries j
      where j.organization_id=org and j.branch_id is not distinct from s.branch_id
      and j.source_document_id=s.source_id and j.source_document_type=s.source_type
      and j.status='posted' and j.reversed_by_journal_id is null
      and j.reverses_journal_id is null and j.total_debit=j.total_credit and j.total_debit<>0) as posted,
      (select r.status from public.finance_posting_receipts r
       where r.organization_id=org and r.branch_id is not distinct from s.branch_id
       and r.source_id=s.source_id order by r.updated_at desc,r.id limit 1) as receipt_status
    from source_rows s
  ), q_source as (
    select m,sum(net) as source_amount,
      sum(net) filter(where not posted and coalesce(receipt_status,'') not in ('failed','blocked')) as awaiting,
      sum(net) filter(where not posted and receipt_status='blocked') as blocked,
      sum(net) filter(where not posted and receipt_status='failed') as failed
    from source_evidence group by m
  ), q_legacy as (
    select public.neo_module_label(k.source_module) as m,
           sum(k.amount) as source_amount,
           sum(k.amount) filter (where k.eligible) as awaiting,
           sum(k.amount) filter (where not k.eligible) as blocked
      from public.neo_finance_posting_queue(_branch, f, t) k
     where public.neo_module_label(k.source_module) not in ('pos','folio')
     group by 1
  ), q as (
    select m,source_amount,awaiting,blocked,failed from q_source
    union all select m,source_amount,awaiting,blocked,null::numeric from q_legacy
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
           case when coalesce(q.m,r.m,g.m) in ('pos','folio')
             then coalesce(q.failed,0) else coalesce(r.failed,0) end::numeric(18,2) as fail
      from q
      full outer join r on r.m = q.m
      full outer join g on g.m = coalesce(q.m, r.m)
  )
  select j.m,
         j.src, j.pst, (j.src - j.pst)::numeric(18,2),
         j.await_amt, j.blk, j.fail,
         case
           when j.m not in ('pos','folio')
             then 'Legacy stream calculation: not certified as earned-revenue reconciliation. Review this stream separately.'
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
end $function$
