-- Read-only. Reports the receipt data path and a few recent POS records for
-- Savanna Crown Nairobi. It omits guest names, payment numbers and credentials.
WITH property AS (
  SELECT b.id,b.organization_id,b.name
  FROM public.neo_public_experience p JOIN public.branches b ON b.id=p.branch_id AND b.organization_id=p.organization_id
  WHERE lower(p.public_slug)='savanna-crown-nairobi'
), routines AS (
  SELECT pg_get_functiondef(to_regprocedure('public.neo_document_payload(text,uuid)')) AS document_source,
    pg_get_functiondef(to_regprocedure('public.neo_pos_sales_tax_receipt(uuid,jsonb)')) AS tax_source
), orders AS (
  SELECT o.id,o.order_number,o.organization_id,o.created_at,o.tax_total
  FROM public.pos_orders o JOIN property b ON b.id=o.branch_id AND b.organization_id=o.organization_id
  ORDER BY o.created_at DESC LIMIT 8
)
SELECT b.name AS property,
  coalesce(strpos(r.document_source,'neo_pos_sales_tax_receipt')>0,false) AS receipt_reads_named_tax,
  coalesce(strpos(r.tax_source,'trim_scale(rate*100)')>0,false) AS receipt_labels_show_saved_rates,
  (SELECT count(*) FROM public.sales_tax_profiles t WHERE t.organization_id=b.organization_id AND t.active) AS active_profiles,
  (SELECT count(*) FROM public.sales_tax_profiles t WHERE t.organization_id=b.organization_id AND t.active AND t.workspace_default) AS active_default_profiles,
  coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'order',o.order_number,'stored_tax',o.tax_total,
      'live_items',(SELECT count(*) FROM public.pos_order_items i WHERE i.order_id=o.id AND i.status NOT IN ('cancelled','voided')),
      'items_with_tax_snapshot',(SELECT count(*) FROM public.pos_order_items i
        WHERE i.order_id=o.id AND i.status NOT IN ('cancelled','voided') AND i.sales_tax_snapshot IS NOT NULL),
      'saved_tax_codes',(SELECT coalesce(jsonb_agg(DISTINCT t.part->>'code'),'[]') FROM public.pos_order_items i
        CROSS JOIN LATERAL jsonb_array_elements(i.sales_tax_snapshot->'taxes') t(part)
        WHERE i.order_id=o.id AND i.status NOT IN ('cancelled','voided')),
      'last_print_tax_rows',(SELECT coalesce((
        SELECT jsonb_agg(t.row) FROM jsonb_array_elements(j.payload#>'{document,totals}') t(row)
        WHERE t.row->>'label' ~* '(tax|vat|levy|included|added)'
      ),'[]') FROM public.print_jobs j
        WHERE j.organization_id=o.organization_id AND j.document_type='pos_receipt'
          AND j.payload#>>'{document,document,number}'=o.order_number
        ORDER BY j.created_at DESC LIMIT 1)
    ) ORDER BY o.created_at DESC) FROM orders o WHERE o.organization_id=b.organization_id
  ),'[]') AS recent_receipts
FROM property b CROSS JOIN routines r;
