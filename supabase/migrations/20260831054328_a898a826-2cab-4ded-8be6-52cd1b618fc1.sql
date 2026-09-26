ALTER TABLE public.night_audit_runs
  ADD COLUMN IF NOT EXISTS run_reference text,
  ADD COLUMN IF NOT EXISTS operator_name text;

CREATE UNIQUE INDEX IF NOT EXISTS night_audit_runs_reference_idx
  ON public.night_audit_runs (organization_id, run_reference)
  WHERE run_reference IS NOT NULL;

CREATE OR REPLACE FUNCTION public.neo_night_audit_reference(_org uuid, _branch uuid, _date date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE code text; seq int;
BEGIN
  SELECT upper(left(regexp_replace(coalesce(b.code, b.name, 'SCN'), '[^A-Za-z0-9]', '', 'g'), 3))
    INTO code FROM public.branches b WHERE b.id = _branch;
  code := coalesce(nullif(code, ''), 'SCN');
  SELECT count(*) + 1 INTO seq
    FROM public.night_audit_runs r
   WHERE r.organization_id = _org AND r.branch_id = _branch
     AND r.business_date = _date AND r.run_reference IS NOT NULL;
  RETURN 'EOD-' || code || '-' || to_char(_date, 'YYYYMMDD') || '-' || lpad(seq::text, 3, '0');
END $function$;

REVOKE ALL ON FUNCTION public.neo_night_audit_reference(uuid, uuid, date) FROM public, anon;

CREATE OR REPLACE FUNCTION public.neo_night_audit_run(_branch uuid, _date date DEFAULT NULL::date, _mode text DEFAULT 'manual'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid:=public.current_org_id(); v_date date:=COALESCE(_date,current_date); v_run uuid;
        v_blocking int:=0; v_warning int:=0; v_pos_revenue numeric:=0; v_pos_paid numeric:=0;
        v_rooms_revenue numeric:=0; v_collections numeric:=0; v_outstanding numeric:=0;
        v_ref text; v_operator text; v_methods jsonb; v_modules jsonb; v_variance numeric:=0;
        v_unposted int:=0; v_failed int:=0; v_unposted_amt numeric:=0;
        v_ap numeric:=0; v_ar numeric:=0; v_grni numeric:=0; v_started timestamptz;
BEGIN
 IF v_org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;
 IF NOT (public.has_permission('finance','eod','view') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Forbidden'; END IF;
 IF _branch IS NULL OR NOT EXISTS(SELECT 1 FROM public.branches b WHERE b.id=_branch AND b.organization_id=v_org) THEN RAISE EXCEPTION 'Unknown property'; END IF;

 SELECT coalesce(p.full_name, p.email) INTO v_operator FROM public.profiles p WHERE p.id = auth.uid();
 v_started := now();

 INSERT INTO public.night_audit_runs(organization_id,branch_id,business_date,run_mode,created_by,started_at,operator_name,run_reference)
 VALUES(v_org,_branch,v_date,COALESCE(_mode,'manual'),auth.uid(),v_started,v_operator,
        public.neo_night_audit_reference(v_org,_branch,v_date))
 ON CONFLICT(organization_id,branch_id,business_date) DO UPDATE
   SET run_mode=EXCLUDED.run_mode, created_by=auth.uid(), started_at=v_started,
       completed_at=NULL, operator_name=EXCLUDED.operator_name,
       run_reference=COALESCE(public.night_audit_runs.run_reference, EXCLUDED.run_reference)
 RETURNING id, run_reference INTO v_run, v_ref;

 DELETE FROM public.night_audit_exceptions WHERE run_id=v_run;
 INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
 SELECT v_run,v_org,_branch,v_date,'cashier-session','blocking',COALESCE(s.shift_number,s.id::text),'Cashier session is still open for the audited business day.',s.expected_cash FROM public.pos_shifts s WHERE s.organization_id=v_org AND s.branch_id=_branch AND s.status='open' AND s.opened_at::date<=v_date;
 INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
 SELECT v_run,v_org,_branch,v_date,'cash-variance','warning',COALESCE(s.shift_number,s.id::text),CASE WHEN s.variance<0 THEN 'Cash shortage recorded on a closed cashier session.' ELSE 'Cash overage recorded on a closed cashier session.' END,s.variance FROM public.pos_shifts s WHERE s.organization_id=v_org AND s.branch_id=_branch AND s.status<>'open' AND s.closed_at::date=v_date AND COALESCE(s.variance,0)<>0;
 INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
 SELECT v_run,v_org,_branch,v_date,'unsettled-bill','warning',o.order_number,'Bill is not fully settled.',GREATEST(COALESCE(o.grand_total,0)-COALESCE(o.paid_total,0),0) FROM public.pos_orders o WHERE o.organization_id=v_org AND o.branch_id=_branch AND o.created_at::date=v_date AND COALESCE(o.payment_status,'unpaid') NOT IN('paid','settled','credit','transferred') AND COALESCE(o.grand_total,0)-COALESCE(o.paid_total,0)>0;
 INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
 SELECT v_run,v_org,_branch,v_date,'open-folio','warning',f.folio_number,'Guest folio carries an outstanding balance.',f.balance FROM public.folios f WHERE f.organization_id=v_org AND f.branch_id=_branch AND f.status='open' AND COALESCE(f.balance,0)<>0;
 INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
 SELECT v_run,v_org,_branch,v_date,'finance-posting','blocking',q.reference,COALESCE(q.last_error,q.required_action),q.amount FROM public.neo_finance_posting_queue(_branch,v_date,v_date) q WHERE q.eligible OR q.posting_status='failed';
 INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
 SELECT v_run,v_org,_branch,v_date,'approval','warning',COALESCE(a.request_number,a.id::text),'Controlled transaction is still awaiting approval.',a.amount FROM public.approval_requests a WHERE a.organization_id=v_org AND a.branch_id=_branch AND a.created_at::date<=v_date AND public.neo_approval_normalize_status(a.status)='pending';

 SELECT COALESCE(sum(o.grand_total),0),COALESCE(sum(o.paid_total),0) INTO v_pos_revenue,v_pos_paid FROM public.pos_orders o WHERE o.organization_id=v_org AND o.branch_id=_branch AND o.created_at::date=v_date;
 SELECT COALESCE(sum(l.total_amount),0) INTO v_rooms_revenue FROM public.folio_lines l WHERE l.organization_id=v_org AND l.branch_id=_branch AND l.posted_at::date=v_date AND l.category='room';
 SELECT COALESCE(sum(f.balance),0) INTO v_outstanding FROM public.folios f WHERE f.organization_id=v_org AND f.branch_id=_branch AND f.status='open';
 v_collections:=v_pos_paid;

 -- Payment totals by method, across point-of-sale and guest payments.
 SELECT COALESCE(jsonb_object_agg(m, amt), '{}'::jsonb) INTO v_methods FROM (
   SELECT COALESCE(x.method,'unspecified') m, round(sum(x.amount),2) amt FROM (
     SELECT p.method, p.amount FROM public.pos_payments p
      WHERE p.organization_id=v_org AND p.branch_id=_branch AND p.created_at::date=v_date
     UNION ALL
     SELECT p.method, p.amount FROM public.payments p
      WHERE p.organization_id=v_org AND p.branch_id=_branch AND p.created_at::date=v_date
   ) x GROUP BY 1) s;

 -- Revenue by module, from the day's folio lines plus the point-of-sale total.
 SELECT COALESCE(jsonb_object_agg(cat, amt), '{}'::jsonb) INTO v_modules FROM (
   SELECT COALESCE(l.category,'other') cat, round(sum(l.total_amount),2) amt
     FROM public.folio_lines l
    WHERE l.organization_id=v_org AND l.branch_id=_branch AND l.posted_at::date=v_date
    GROUP BY 1) f;
 v_modules := v_modules || jsonb_build_object('pos', round(v_pos_revenue,2));

 SELECT COALESCE(sum(s.variance),0) INTO v_variance FROM public.pos_shifts s
  WHERE s.organization_id=v_org AND s.branch_id=_branch AND s.status<>'open' AND s.closed_at::date=v_date;

 SELECT count(*) FILTER (WHERE q.eligible), count(*) FILTER (WHERE q.posting_status='failed'),
        COALESCE(sum(q.amount) FILTER (WHERE q.eligible),0)
   INTO v_unposted, v_failed, v_unposted_amt
   FROM public.neo_finance_posting_queue(_branch, v_date, v_date) q;

 SELECT COALESCE(sum(GREATEST(COALESCE(i.amount,0)-COALESCE(i.paid_amount,0),0)),0) INTO v_ap
   FROM public.supplier_invoices i WHERE i.organization_id=v_org AND COALESCE(i.status,'') <> 'cancelled';
 SELECT COALESCE(sum(f.balance),0) INTO v_ar FROM public.folios f
  WHERE f.organization_id=v_org AND f.branch_id=_branch AND COALESCE(f.balance,0) > 0;
 SELECT COALESCE(sum(g.accrued_value),0) INTO v_grni FROM public.goods_receipts g
  WHERE g.organization_id=v_org AND g.branch_id=_branch AND g.accrual_journal_id IS NOT NULL;

 IF round(v_pos_revenue-v_pos_paid,2)<>0 THEN
   INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
   VALUES(v_run,v_org,_branch,v_date,'revenue-reconciliation','warning','Revenue vs collections','Recorded revenue does not equal collections; the difference must sit in authorised outstanding balances.',round(v_pos_revenue-v_pos_paid,2));
 END IF;

 SELECT count(*) FILTER(WHERE severity='blocking'),count(*) FILTER(WHERE severity='warning')
   INTO v_blocking,v_warning FROM public.night_audit_exceptions WHERE run_id=v_run;

 UPDATE public.night_audit_runs
    SET blocking_count=v_blocking, warning_count=v_warning,
        status=CASE WHEN v_blocking>0 THEN 'exception' ELSE 'completed' END,
        completed_at=now(),
        summary=jsonb_build_object(
          'reference', v_ref,
          'operator', v_operator,
          'started_at', v_started,
          'finished_at', now(),
          'pos_revenue', v_pos_revenue,
          'pos_collections', v_pos_paid,
          'rooms_revenue', v_rooms_revenue,
          'collections', v_collections,
          'outstanding_balances', v_outstanding,
          'revenue_by_module', v_modules,
          'payments_by_method', v_methods,
          'till_variance', round(v_variance,2),
          'unposted_count', v_unposted,
          'unposted_amount', round(v_unposted_amt,2),
          'failed_postings', v_failed,
          'accounts_payable', round(v_ap,2),
          'accounts_receivable', round(v_ar,2),
          'grni_balance', round(v_grni,2),
          'blocking', v_blocking,
          'warnings', v_warning,
          'outcome', CASE WHEN v_blocking>0 THEN 'exception' ELSE 'completed' END)
  WHERE id=v_run;

 RETURN jsonb_build_object('run_id',v_run,'reference',v_ref,'business_date',v_date,
        'blocking',v_blocking,'warnings',v_warning,
        'status',CASE WHEN v_blocking>0 THEN 'exception' ELSE 'completed' END);
END $function$;

REVOKE ALL ON FUNCTION public.neo_night_audit_run(uuid, date, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_night_audit_run(uuid, date, text) TO authenticated;