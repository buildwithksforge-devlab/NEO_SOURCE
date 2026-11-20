BEGIN;

CREATE FUNCTION public.neo_sales_tax_finance_summary(_branch uuid,_from date,_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org uuid:=public.current_org_id(); result jsonb;
BEGIN
  IF org IS NULL OR NOT (public.is_org_admin() OR public.has_permission('finance','view')) THEN
    RAISE EXCEPTION 'Sales tax reporting requires Finance access' USING ERRCODE='42501';
  END IF;
  IF _from IS NULL OR _to IS NULL OR _from>_to OR _to-_from>366 THEN
    RAISE EXCEPTION 'Choose a reporting period of no more than one year' USING ERRCODE='22023';
  END IF;
  IF _branch IS NOT NULL AND NOT coalesce(public.neo_branch_in_scope(_branch),false) THEN
    RAISE EXCEPTION 'Reporting property is out of scope' USING ERRCODE='42501';
  END IF;
  WITH sales AS (
    SELECT o.id,o.branch_id,o.currency,o.subtotal,o.discount_total,o.tax_total,
      greatest(o.subtotal-o.discount_total,0) gross
    FROM public.pos_orders o
    WHERE o.organization_id=org AND (_branch IS NULL OR o.branch_id=_branch)
      AND coalesce(public.neo_branch_in_scope(o.branch_id),false)
      AND EXISTS(SELECT 1 FROM public.pos_order_items i WHERE i.order_id=o.id AND i.sales_tax_snapshot IS NOT NULL
        AND i.status NOT IN ('voided','cancelled'))
      AND EXISTS(
        SELECT 1 FROM public.journal_entries j
        WHERE j.organization_id=org AND j.branch_id IS NOT DISTINCT FROM o.branch_id AND j.currency=o.currency
          AND j.status='posted' AND j.reversed_by_journal_id IS NULL AND j.accounting_date BETWEEN _from AND _to
          AND (j.source_document_type='pos_order:revenue' AND j.source_document_id=o.id
            OR j.source_document_type='folio_charge:revenue' AND EXISTS(
              SELECT 1 FROM public.folio_lines f WHERE f.id=j.source_document_id AND f.organization_id=org
                AND f.source_record_uuid=o.id AND f.source_module IN ('pos','pos_order') AND f.category<>'gratuity')
            OR EXISTS(SELECT 1 FROM public.delivery_orders d
              WHERE d.organization_id=org AND d.pos_order_id=o.id AND (
                j.source_document_type='delivery_order:revenue' AND j.source_document_id=d.id
                OR j.source_document_type='delivery_invoice' AND EXISTS(
                  SELECT 1 FROM public.invoice_lines i WHERE i.invoice_id=j.source_document_id
                    AND i.organization_id=org AND i.source_module='delivery' AND i.source_record_id=d.id))))
      )
  ), money AS (
    SELECT currency,sum(gross) gross,sum(gross-tax_total) net,count(*) sales
    FROM sales GROUP BY currency
  ), taxes AS (
    SELECT s.currency,t.code,t.label,t.account_code,sum(t.amount) amount
    FROM sales s CROSS JOIN LATERAL public.neo_pos_saved_sales_taxes(s.id,s.subtotal,s.gross) t
    GROUP BY 1,2,3,4
  ), treatment AS (
    SELECT s.currency, CASE
      WHEN i.sales_tax_snapshot->>'treatment'='exempt'
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(i.sales_tax_snapshot->'rules') r WHERE r->>'treatment'='exempt')
        THEN 'Exempt'
      WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(i.sales_tax_snapshot->'taxes') t
        WHERE t->>'treatment'='zero_rated') THEN 'Zero rated'
      ELSE 'No applicable tax' END label,
      sum(CASE WHEN s.subtotal>0 THEN round(i.line_total*s.gross/s.subtotal,2) ELSE 0 END) amount
    FROM sales s JOIN public.pos_order_items i ON i.order_id=s.id
    WHERE i.sales_tax_snapshot IS NOT NULL AND i.tax_amount=0 AND i.status NOT IN ('voided','cancelled')
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(i.sales_tax_snapshot->'taxes') r WHERE r->>'treatment'='standard')
    GROUP BY 1,2
  ), refunds AS (
    SELECT j.currency,a.code,a.name label,sum(l.debit) amount
    FROM public.cash_refund_requests r
    JOIN public.pos_payments p ON p.id=r.pos_payment_id AND p.organization_id=org
    JOIN public.pos_orders o ON o.id=p.order_id AND o.organization_id=org
    JOIN public.payments payout ON payout.id=r.refund_payment_id AND payout.organization_id=org
    JOIN public.journal_entries j ON j.id=payout.posted_journal_id AND j.organization_id=org
    JOIN public.journal_entry_lines l ON l.journal_id=j.id AND l.organization_id=org
    JOIN public.chart_of_accounts a ON a.id=l.account_id AND a.organization_id=org
    WHERE r.organization_id=org AND r.status='settled' AND j.status='posted'
      AND j.reversed_by_journal_id IS NULL AND j.accounting_date BETWEEN _from AND _to
      AND (_branch IS NULL OR j.branch_id=_branch) AND coalesce(public.neo_branch_in_scope(j.branch_id),false)
      AND l.debit>0 AND EXISTS(
        SELECT 1 FROM public.pos_order_items item WHERE item.order_id=o.id AND item.sales_tax_snapshot IS NOT NULL
          AND item.status NOT IN ('voided','cancelled'))
      AND EXISTS(SELECT 1 FROM public.neo_pos_saved_sales_taxes(o.id,o.subtotal,o.subtotal-o.discount_total) tax
        WHERE tax.amount>0 AND tax.account_code=a.code)
    GROUP BY 1,2,3
  )
  SELECT jsonb_build_object(
    'sales',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.currency) FROM money m),'[]'),
    'taxes',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.currency,t.code) FROM taxes t),'[]'),
    'treatments',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.currency,t.label) FROM treatment t),'[]'),
    'refunds',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.currency,r.code) FROM refunds r),'[]')
  ) INTO result;
  RETURN result;
END
$$;

REVOKE ALL ON FUNCTION public.neo_sales_tax_finance_summary(uuid,date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_sales_tax_finance_summary(uuid,date,date) TO authenticated;
COMMIT;
