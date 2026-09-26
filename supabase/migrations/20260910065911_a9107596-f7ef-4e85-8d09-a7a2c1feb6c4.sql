-- 1) Exception register: the per-row LATERAL call into neo_finance_posting_queue
-- re-ran a 500-row scan for every exception, which exceeded the statement
-- timeout. The queue only derives drill_to from the module, so inline it.
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
 WHERE s.organization_id=org AND s.financial_state IN('blocked','failed') AND (_branch IS NULL OR s.branch_id=_branch) AND (_from IS NULL OR s.occurred_at::date>=_from) AND (_to IS NULL OR s.occurred_at::date<=_to)
 UNION ALL
 SELECT 'blocked',public.neo_canonical_posting_module(r.source_module),coalesce(r.source_reference,r.source_id::text),r.source_id,r.amount,r.currency,coalesce(r.occurred_on,r.created_at::date),greatest(0,today-coalesce(r.occurred_on,r.created_at::date)),'blocked','Posting receipt is not backed by a balanced posted journal','Posting receipt is not backed by a balanced posted journal','Finance','Repair the journal link or reverse and repost.','/finance/posting',r.updated_at,r.attempts,r.last_error,r.branch_id,b.name
 FROM public.finance_posting_receipts r LEFT JOIN public.branches b ON b.id=r.branch_id LEFT JOIN public.journal_entries j ON j.id=r.journal_id
 WHERE r.organization_id=org AND r.status='posted' AND (j.id IS NULL OR j.status<>'posted' OR abs(coalesce(j.total_debit,0)-coalesce(j.total_credit,0))>=0.01) AND (_branch IS NULL OR r.branch_id=_branch) AND (_from IS NULL OR coalesce(r.occurred_on,r.created_at::date)>=_from) AND (_to IS NULL OR coalesce(r.occurred_on,r.created_at::date)<=_to)
 ORDER BY 1,7 DESC;
END $function$;

CREATE INDEX IF NOT EXISTS idx_cts_org_state_occurred ON public.canonical_transaction_states(organization_id, financial_state, occurred_at);
CREATE INDEX IF NOT EXISTS idx_fin_receipts_lookup ON public.finance_posting_receipts(organization_id, source_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fin_receipts_org_status ON public.finance_posting_receipts(organization_id, status);

-- 2) Setup badges: these three settings tables hold provider credentials and are
-- deliberately unreadable by the app role. Expose presence only.
CREATE OR REPLACE FUNCTION public.neo_settings_presence()
 RETURNS TABLE(mpesa boolean, etims boolean, ai_provider boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid:=public.current_org_id(); BEGIN
 IF org IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT
  EXISTS(SELECT 1 FROM public.mpesa_settings t WHERE t.organization_id=org),
  EXISTS(SELECT 1 FROM public.etims_settings t WHERE t.organization_id=org),
  EXISTS(SELECT 1 FROM public.ai_provider_settings t WHERE t.organization_id=org);
END $function$;

REVOKE ALL ON FUNCTION public.neo_settings_presence() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_settings_presence() TO authenticated, service_role;