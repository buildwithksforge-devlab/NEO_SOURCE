CREATE OR REPLACE FUNCTION public.neo_finance_post_family(_module text, _source uuid, _silent boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  res jsonb; branch uuid; amount numeric := 0; ref text; occurred date; cur text;
  journal uuid; okd boolean; msg text;
BEGIN
  IF _module = 'deposit' THEN
    RETURN public.neo_deposit_post(_source, _silent);
  ELSIF _module = 'payment' THEN
    RETURN public.neo_payment_post(_source, _silent);
  ELSIF _module NOT IN ('inventory', 'supplier_invoice', 'supplier_payment') THEN
    RETURN public.neo_finance_post_source(_module, _source, _silent);
  END IF;

  -- Procurement families: stock receipts, supplier invoices, supplier payments.
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('finance','edit')
          OR public.has_permission('finance','approve')) AND NOT _silent THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_module || ':' || _source::text, 0));

  IF EXISTS (SELECT 1 FROM public.finance_posting_receipts
              WHERE organization_id = org AND idempotency_key = _module || ':' || _source::text
                AND status = 'posted') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_posted', 'module', _module, 'source_id', _source);
  END IF;

  IF _module = 'inventory' THEN
    SELECT g.branch_id, coalesce(g.total_value,0), coalesce(g.grn_number, g.id::text),
           coalesce(g.delivery_date, (g.received_at)::date, (g.created_at)::date)
      INTO branch, amount, ref, occurred
      FROM public.goods_receipts g WHERE g.id = _source AND g.organization_id = org;
    IF ref IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;

    IF EXISTS (SELECT 1 FROM public.goods_receipts g WHERE g.id = _source AND g.reversed_at IS NOT NULL) THEN
      res := jsonb_build_object('ok', false, 'reason', 'reversed',
             'detail', 'This receipt was reversed — no further posting is required.');
    ELSIF NOT EXISTS (SELECT 1 FROM public.goods_receipts g WHERE g.id = _source
                       AND g.status IN ('received','accepted','completed','closed')) THEN
      res := jsonb_build_object('ok', false, 'reason', 'not_accepted',
             'detail', 'Complete and accept the receipt in Stores before it can be recognised.');
    ELSE
      res := public.neo_grn_post_accrual(_source);
    END IF;

  ELSIF _module = 'supplier_invoice' THEN
    SELECT v.branch_id, coalesce(v.amount,0), coalesce(v.invoice_number, v.id::text),
           coalesce(v.invoice_date, (v.created_at)::date)
      INTO branch, amount, ref, occurred
      FROM public.supplier_invoices v WHERE v.id = _source AND v.organization_id = org;
    IF ref IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    res := public.neo_supplier_invoice_accept(_source, NULL);

  ELSE
    SELECT sp.branch_id, coalesce(sp.amount,0), coalesce(sp.payment_number, sp.id::text),
           coalesce(sp.paid_on, (sp.created_at)::date)
      INTO branch, amount, ref, occurred
      FROM public.supplier_payments sp WHERE sp.id = _source AND sp.organization_id = org;
    IF ref IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    res := public.neo_supplier_payment_advance(_source, 'settle', NULL);
  END IF;

  okd := coalesce((res->>'ok')::boolean, res ? 'journal_id');
  journal := nullif(res->>'journal_id','')::uuid;
  msg := coalesce(res->>'detail', res->>'reason');
  cur := public.neo_fact_currency(org, branch);

  PERFORM public.neo_record_posting_receipt(
    org, branch, _module, _source, ref,
    CASE WHEN okd THEN 'posted' ELSE 'blocked' END,
    amount, cur, NULL, msg, NULL, occurred);

  RETURN res || jsonb_build_object('ok', okd, 'module', _module, 'source_id', _source,
                                   'journal_id', journal);
EXCEPTION WHEN OTHERS THEN
  PERFORM public.neo_record_posting_receipt(org, branch, _module, _source, ref, 'failed',
    amount, coalesce(cur, 'KES'), NULL, NULL, SQLERRM, occurred);
  IF _silent THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', SQLERRM,
                              'module', _module, 'source_id', _source);
  END IF;
  RAISE;
END $function$;

REVOKE ALL ON FUNCTION public.neo_finance_post_family(text, uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_post_family(text, uuid, boolean) TO authenticated;