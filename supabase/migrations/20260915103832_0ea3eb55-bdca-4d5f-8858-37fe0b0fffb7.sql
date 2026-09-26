CREATE OR REPLACE FUNCTION public.neo_finance_exception_register(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS TABLE(kind text, module text, reference text, source_id uuid, amount numeric, currency text, occurred_on date, age_days integer, status text, reason text, detail text, responsible text, action text, drill_to text, last_attempt timestamp with time zone, attempts integer, last_error text, branch_id uuid, property text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid:=public.current_org_id(); today date:=current_date; BEGIN
 IF org IS NULL OR NOT(public.is_org_admin() OR public.has_permission('finance','view') OR public.can_read_general_ledger()) THEN RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT s.financial_state,s.source_module,coalesce(s.source_reference,s.source_id::text),s.source_id,s.amount,s.currency,s.occurred_at::date,greatest(0,today-s.occurred_at::date),s.financial_state,coalesce(s.blocking_reason,s.next_action),coalesce(s.blocking_reason,s.next_action),'Finance',coalesce(s.next_action,'Resolve at source and retry.'),
  CASE s.source_module WHEN 'inventory' THEN '/inventory/receiving' WHEN 'supplier_invoice' THEN '/finance/payables' WHEN 'supplier_payment' THEN '/finance/payables' WHEN 'deposit' THEN '/finance/deposits' WHEN 'payment' THEN '/finance/queue' WHEN 'pos' THEN '/pos/orders' WHEN 'events' THEN '/events/bookings' WHEN 'delivery' THEN '/delivery' WHEN 'laundry' THEN '/laundry' ELSE '/finance/posting' END,
  s.updated_at,coalesce(r.attempts,0),r.last_error,s.branch_id,b.name
 FROM public.canonical_transaction_states s LEFT JOIN public.branches b ON b.id=s.branch_id LEFT JOIN LATERAL(SELECT x.attempts,x.last_error FROM public.finance_posting_receipts x WHERE x.organization_id=s.organization_id AND public.neo_canonical_posting_module(x.source_module)=s.source_module AND x.source_id=s.source_id ORDER BY x.updated_at DESC LIMIT 1)r ON true
 WHERE s.organization_id=org AND s.financial_state IN('blocked','failed')
   -- The night audit writes its own lifecycle record, so an exception run left
   -- a blocked record that the next run counted as a fresh exception forever.
   AND NOT EXISTS (SELECT 1 FROM public.night_audit_runs nr WHERE nr.id = s.source_id)
   AND (_branch IS NULL OR s.branch_id=_branch) AND (_from IS NULL OR s.occurred_at::date>=_from) AND (_to IS NULL OR s.occurred_at::date<=_to)
 UNION ALL
 SELECT 'blocked',public.neo_canonical_posting_module(r.source_module),coalesce(r.source_reference,r.source_id::text),r.source_id,r.amount,r.currency,coalesce(r.occurred_on,r.created_at::date),greatest(0,today-coalesce(r.occurred_on,r.created_at::date)),'blocked','Posting receipt is not backed by a balanced posted journal','Posting receipt is not backed by a balanced posted journal','Finance','Repair the journal link or reverse and repost.','/finance/posting',r.updated_at,r.attempts,r.last_error,r.branch_id,b.name
 FROM public.finance_posting_receipts r LEFT JOIN public.branches b ON b.id=r.branch_id LEFT JOIN public.journal_entries j ON j.id=r.journal_id
 WHERE r.organization_id=org AND r.status='posted' AND (j.id IS NULL OR j.status<>'posted' OR abs(coalesce(j.total_debit,0)-coalesce(j.total_credit,0))>=0.01) AND (_branch IS NULL OR r.branch_id=_branch) AND (_from IS NULL OR coalesce(r.occurred_on,r.created_at::date)>=_from) AND (_to IS NULL OR coalesce(r.occurred_on,r.created_at::date)<=_to)
 UNION ALL
 SELECT 'failed',public.neo_canonical_posting_module(r.source_module),coalesce(r.source_reference,r.source_id::text),r.source_id,r.amount,r.currency,coalesce(r.occurred_on,r.created_at::date),greatest(0,today-coalesce(r.occurred_on,r.created_at::date)),'failed',coalesce(nullif(r.last_error,''),'Posting attempt failed'),coalesce(nullif(r.last_error,''),'Posting attempt failed'),'Finance','Resolve the cause at source and retry the posting.',
  CASE public.neo_canonical_posting_module(r.source_module) WHEN 'inventory' THEN '/inventory/receiving' WHEN 'supplier_invoice' THEN '/finance/payables' WHEN 'supplier_payment' THEN '/finance/payables' WHEN 'deposit' THEN '/finance/deposits' WHEN 'payment' THEN '/finance/queue' WHEN 'pos' THEN '/pos/orders' WHEN 'events' THEN '/events/bookings' WHEN 'delivery' THEN '/delivery' WHEN 'laundry' THEN '/laundry' ELSE '/finance/posting' END,
  r.updated_at,r.attempts,r.last_error,r.branch_id,b.name
 FROM public.finance_posting_receipts r LEFT JOIN public.branches b ON b.id=r.branch_id
 WHERE r.organization_id=org AND r.status IN('failed','blocked')
   AND NOT EXISTS (SELECT 1 FROM public.canonical_transaction_states s2 WHERE s2.organization_id=r.organization_id AND s2.source_id=r.source_id AND s2.financial_state IN('blocked','failed'))
   AND (_branch IS NULL OR r.branch_id=_branch) AND (_from IS NULL OR coalesce(r.occurred_on,r.created_at::date)>=_from) AND (_to IS NULL OR coalesce(r.occurred_on,r.created_at::date)<=_to)
 ORDER BY 1,7 DESC;
END $function$;