BEGIN;

CREATE OR REPLACE FUNCTION public.neo_pos_sales_tax_receipt(_order uuid,_totals jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $receipt$
DECLARE sale public.pos_orders; tax_rows jsonb; total_tax numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id=_order AND sales_tax_snapshot IS NOT NULL
    AND status NOT IN ('cancelled','voided')) THEN RETURN _totals; END IF;
  SELECT * INTO STRICT sale FROM public.pos_orders WHERE id=_order;

  -- Keep exactly the cents already allocated to each tax in Finance. Split
  -- those cents across distinct rates from the original saved line snapshots.
  WITH ledger AS (
    SELECT t.code,t.label,t.included,sum(t.amount) amount
    FROM public.neo_pos_saved_sales_taxes(_order,sale.subtotal,sale.subtotal-sale.discount_total) t
    GROUP BY 1,2,3
  ), rates AS (
    SELECT part->>'code' code,part->>'name' label,(part->>'inclusive')::boolean included,
      part->>'method' method,(part->>'value')::numeric rate,sum((part->>'amount')::numeric) raw
    FROM public.pos_order_items i
    CROSS JOIN LATERAL jsonb_array_elements(i.sales_tax_snapshot->'taxes') AS t(part)
    WHERE i.order_id=_order AND i.status NOT IN ('cancelled','voided')
    GROUP BY 1,2,3,4,5
  ), numbered AS (
    SELECT l.*,r.method,r.rate,r.raw,
      sum(r.raw) OVER (PARTITION BY l.code,l.label,l.included ORDER BY r.method,r.rate) AS running,
      sum(r.raw) OVER (PARTITION BY l.code,l.label,l.included) AS rate_total
    FROM ledger l LEFT JOIN rates r USING(code,label,included)
  ), formatted AS (
    SELECT code,label,included,method,rate,
      CASE WHEN method='percentage' AND rate IS NOT NULL THEN trim_scale(rate*100)::text||'% ' ELSE '' END
        || CASE WHEN code='LEGACY' THEN 'Recorded tax' ELSE label END
        || CASE WHEN code IN ('LEGACY',label) THEN '' ELSE ' ('||code||')' END
        || CASE WHEN method='fixed' AND rate IS NOT NULL THEN ' ('||trim_scale(rate)::text||' per unit)' ELSE '' END
        || CASE WHEN included THEN ' · Included' ELSE ' · Added' END AS receipt_label,
      CASE WHEN rate_total IS NULL THEN amount WHEN rate_total=0 THEN 0
        ELSE round(amount*running/rate_total,2)-round(amount*(running-raw)/rate_total,2) END AS receipt_amount
    FROM numbered
  )
  SELECT coalesce(sum(receipt_amount),0),
    coalesce(jsonb_agg(jsonb_build_object('label',receipt_label,'amount',receipt_amount)
      ORDER BY code,label,included,method,rate),'[]')
  INTO total_tax,tax_rows FROM formatted;
  RETURN public.neo_document_replace_tax_total(_totals,tax_rows,greatest(sale.subtotal-sale.discount_total,0)-total_tax);
END;
$receipt$;
REVOKE ALL ON FUNCTION public.neo_pos_sales_tax_receipt(uuid,jsonb) FROM PUBLIC,anon,authenticated;

-- Both the browser PDF and physical print jobs call this canonical payload.
-- A database where the tax tables arrived before the receipt hook can be
-- repaired without replacing its current document permissions or other paths.
DO $document$
DECLARE source text := pg_get_functiondef('public.neo_document_payload(text,uuid)'::regprocedure);
  old text := $old$'totals', coalesce(_totals, '[]'::jsonb),$old$;
  patched text := $new$'totals', CASE WHEN _type='pos_receipt'
    THEN public.neo_pos_sales_tax_receipt(_id,coalesce(_totals,'[]'::jsonb))
    ELSE coalesce(_totals,'[]'::jsonb) END,$new$;
BEGIN
  IF strpos(source,'neo_pos_sales_tax_receipt')>0 THEN RETURN; END IF;
  IF (length(source)-length(replace(source,old,'')))<>length(old)
      OR strpos(source,'''pos_receipt''')=0 THEN
    RAISE EXCEPTION 'The installed document payload needs review before enabling named receipt taxes';
  END IF;
  EXECUTE replace(source,old,patched);
END;
$document$;
NOTIFY pgrst,'reload schema';
COMMIT;
